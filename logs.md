# План улучшения логирования расшифровок (до 1 часа и более)

## Цели
- Надежность: без гонок, без потери данных, корректное завершение.
- Производительность: минимальная нагрузка на память/CPU/диск при длительных сессиях.
- Восстановление: безопасная работа при сбоях и перезапуске.
- Совместимость: сохраняем Markdown в `./Logs`, как и сейчас.

## Ключевая идея
- Перенести запись на диск полностью в главный процесс (Electron main) и писать потоково через `fs.createWriteStream` с флагом `a` (append), строго соблюдая backpressure (`write()` + ожидание события `drain`).
- Рендерер формирует короткие Markdown‑записи и отправляет их в main по IPC (`append`), не храня весь файл в памяти и не переписывая файл целиком.

## Архитектура
- Main (`main.js`): `LogManager` — менеджер потоков записи по ключу файла с ротацией, лимитами, аккуратной политикой fsync и завершением.
- Preload (`preload.js`): тонкий мост IPC (`createLog`, `appendLog`, `finalizeLog`, `getLogStatus`).
- Renderer (`renderer.js`): форматирование записей (санитизация + Markdown), ранняя инициализация логов, отправка `append` на каждую завершенную фразу.

## IPC API (новый контракт)
- `ensure-log-directory(dirPath)` — оставить как есть (валидация каталога).
- `create-log(sessionId, type, header)` → `{ success, path, part }`
  - Открывает/создает поток записи, дописывает заголовок (если новый/новая часть).
- `append-log(sessionId, type, chunk)` → `{ success, size, part }`
  - Добавляет запись; при `write()` вернул `false` — ждать `drain`.
- `finalize-log(sessionId, type, footer)` → `{ success }`
  - Пишет футер (итоги), закрывает поток и делает финальный `fsync`.
- `get-log-status(sessionId, type)` → `{ size, part, path, startedAt }`

Ключ `type`: `microphone` | `speaker`.

## LogManager (main.js)
- Структура: `Map<logKey, { stream, size, part, createdAt, path }>` где `logKey = `${sessionId}:${type}``.
- Поток: `fs.createWriteStream(path, { flags: 'a', encoding: 'utf8', highWaterMark: 64 * 1024 })`.
- Валидация пути: строгая, только внутри `./Logs`, запрет `..`, `~`, спецсимволы.
- Санитизация дублируется (defense-in-depth): базовое экранирование и выравнивание переводов строк.
- Ротация:
  - По размеру: лимит, например `10 MB` на файл. При превышении — закрыть текущий и открыть `*_partNN.md`.
  - Опционально по времени: новый файл каждые 15–30 минут (конфиг).
- Журналирование/долговечность:
  - Обрабатывать события `error`, `drain`, `close` и использовать backpressure: если `stream.write()` вернул `false`, ждать `drain` перед следующей записью.
  - Политика fsync: не вызывать `fs.fsync` на каждую запись (дорого). Достаточно:
    - `fs.fsync(stream.fd)` при `finalize-log`;
    - опционально — периодический fsync раз в 5–30 секунд или каждые 50–200 записей (настраивается), если критична минимизация риска потери нескольких последних строк при внезапном отключении питания.
  - Для редких операций переписывания существующего файла (например, обновление «Оглавления» в первой части при ротации) — использовать атомарную запись (библиотека `write-file-atomic`) вместо ручных временных файлов.
- Завершение:
  - `finalize-log` дописывает сводку, вызывает `stream.end()`, удаляет запись из `Map`, выполняет финальный fsync.
  - На `app.before-quit` закрыть все активные потоки, при необходимости дописать “aborted session footer”.

## Renderer (renderer.js)
- Ранняя инициализация: вызывать `create-log` ДО запуска сессий распознавания, чтобы не потерять первые complete‑события.
- Формат записи:
  - Заголовок (один раз на файл/часть): `# [Stream] Transcription Log`, `Session ID`, `Start Time`, `Model`, `Part N`, `---`.
  - Запись: `## HH:MM:SS - YYYY-MM-DD`, затем `**Transcript:** ...`, опционально `**Processing Latency:** ...`, затем `---`.
- Санитизация: текущая схема (`replace` переносов, экранирование спецсимволов) + настраиваемый лимит длины фразы.
- Отказ от in‑memory полного буфера: `micLogBuffer/speakerLogBuffer` больше не хранить; писать только append.
- Мини‑буферизация (по желанию): агрегировать 0.5–2 сек записей и слать пачкой для снижения IPC вызовов.
- Временные метки: для консистентности в логах использовать `toISOString()` (UTC) и, при желании, рядом локальное время.

### Пример корректной обработки backpressure (псевдокод main.js)
```js
import { once } from 'node:events';

async function appendSafe(stream, chunk) {
  if (!stream.write(chunk)) {
    await once(stream, 'drain');
  }
}
```

## Формат файлов и ротация
- Имена: `microphone_{sessionId}.md` и `speaker_{sessionId}.md`.
- При ротации: `microphone_{sessionId}_part02.md`. В заголовке указывать `Part: 2`.
- Необязательно, но полезно: в первой части поддерживать “Оглавление” со ссылками на части (обновлять при каждой ротации). Для обновления оглавления — атомарная запись.
- Альтернатива для надежности (опционально): параллельно вести `*.ndjson` с одной записью на строку для машинной обработки/восстановления.

### Производственный путь для логов
- В dev оставляем `./Logs`.
- Для прод‑сборки Electron предпочтительнее `path.join(app.getPath('userData'), 'Logs')` или `app.getPath('logs')` (если подходит политика платформы): директории приложения могут быть «read‑only».

### Безопасное формирование путей
```js
const root = path.resolve(logRoot);
const filename = makeSafeFilename(/* без пробелов и опасных символов */);
const full = path.join(root, filename);
const rel = path.relative(root, full);
if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path traversal');
```

## Безопасность и UX
- Оставить строгую валидацию пути; все файловые операции — только через IPC.
- Настройки окна Electron по гайдлайнам безопасности:
  - `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` (по возможности), `webSecurity: true`;
  - не использовать `remote`;
  - включить CSP (Content‑Security‑Policy) через meta‑тег.
- Индикатор в UI: `Logging: On/Off, File: size MB, Part: N` + уведомления об ошибках логирования.
- Настройки: переключатель “Обрезать длинные фразы до N символов”, параметры ротации (по размеру/времени), опция “Disable logging”.

## План внедрения (миграция)
1. Main: реализовать `LogManager` (create/append/finalize, ротация, backpressure, безопасная политика fsync, защита путей).
2. Preload: экспортировать `createLog/appendLog/finalizeLog/getLogStatus`.
3. Renderer:
   - Перенести инициализацию логов до старта распознавания.
   - Заменить текущие `writeLogFile` на `appendLog`.
   - Удалить глобальные буферы и `WriteQueue`, зависящие от полного содержимого.
   - Добавить индикатор статуса логгера и обработку ошибок.
4. Опционально: включить ротацию по 10MB и периодический `fsync` (например, раз в 10–30 секунд или каждые 100 записей).
5. Тесты: стресс‑тест на длительной сессии (60 минут), эмуляция 1000+ записей, проверка целостности и отсутствия гонок.

## Критерии приемки
- Файлы не переписываются целиком; используется append и не растет потребление памяти с длительностью.
- Нет потери записей при одновременных событиях микрофона и системного звука.
- Корректная ротация по размеру: новые части создаются автоматически, ссылки/Part обновляются.
- При аварийном завершении след. запуск дописывает “aborted”/корректно закрывает предыдущий файл.
- UI отображает статус логгера и ошибки.

## Открытые вопросы (для согласования)
- Точный порог ротации: 5MB, 10MB или настраиваемо?
- Ротация по времени нужна ли (каждые 15/30 мин) или только по размеру?
- Нужен ли параллельный `NDJSON` для восстановления/аналитики?
- Нужна ли локализация формата времени или зафиксировать ISO‑8601 в логах?

## Эскиз интерфейсов (псевдокод)

```ts
// preload.js
contextBridge.exposeInMainWorld('electronAPI', {
  ensureLogDirectory: (dir) => ipcRenderer.invoke('ensure-log-directory', dir),
  createLog: (sessionId, type, header) => ipcRenderer.invoke('create-log', sessionId, type, header),
  appendLog: (sessionId, type, chunk) => ipcRenderer.invoke('append-log', sessionId, type, chunk),
  finalizeLog: (sessionId, type, footer) => ipcRenderer.invoke('finalize-log', sessionId, type, footer),
  getLogStatus: (sessionId, type) => ipcRenderer.invoke('get-log-status', sessionId, type),
});

// main.js (фрагмент)
import { once } from 'node:events';
class LogManager {
  constructor(root) { this.root = root; this.items = new Map(); }
  create(sessionId, type, header) { /* open stream, write header, set size/part */ }
  async append(sessionId, type, chunk) { /* write, handle drain (backpressure), rotate on size */ }
  finalize(sessionId, type, footer) { /* write footer, fsync, end */ }
}

async function appendSafe(stream, chunk) {
  if (!stream.write(chunk)) {
    await once(stream, 'drain');
  }
}
```

## Ссылки и примечания
- Node.js Streams (backpressure) и Writable Streams API — использовать `write()` и ожидание `drain`.
- Node.js fs — `createWriteStream`, `fsync`: см. официальную документацию Node.js.
- Electron Security Guidelines — контекстная изоляция, CSP, запреты опасных флагов.
- Ротация файлов: библиотеки `file-stream-rotator`, `rotating-file-stream` (опционально, если понадобится сложная стратегия ротации).
- Атомарная перезапись (точечно, не для append): `write-file-atomic`.

