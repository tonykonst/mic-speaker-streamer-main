const { app, BrowserWindow, ipcMain } = require('electron')
const { initMain: initAudioLoopback } = require('electron-audio-loopback');
const path = require('node:path')
const fs = require('node:fs')
const dotenv = require('dotenv');

dotenv.config();

initAudioLoopback();

// Path validation functions for security
function validateLogPath(filePath) {
  const resolved = path.resolve(filePath);
  const allowedDir = path.resolve('./Logs');

  // Check if path is within allowed directory and doesn't contain traversal
  if (!resolved.startsWith(allowedDir) || resolved.includes('..') || resolved.includes('~')) {
    throw new Error('Invalid file path: Path traversal not allowed');
  }

  // Additional checks for dangerous characters
  if (/[<>:"|?*\x00-\x1f]/.test(filePath)) {
    throw new Error('Invalid file path: Contains illegal characters');
  }

  return resolved;
}

function validateLogDirectory(dirPath) {
  const resolved = path.resolve(dirPath);
  const allowedDir = path.resolve('./Logs');

  // Only allow the Logs directory and subdirectories
  if (!resolved.startsWith(allowedDir) || resolved.includes('..')) {
    throw new Error('Invalid directory path: Only Logs directory allowed');
  }

  return resolved;
}

// IPC handlers for logging
ipcMain.handle('ensure-log-directory', async (event, dirPath) => {
  try {
    // Validate path before creating directory
    const validatedPath = validateLogDirectory(dirPath);
    await fs.promises.mkdir(validatedPath, { recursive: true });
    return { success: true };
  } catch (error) {
    console.error('Error creating log directory:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('write-log-file', async (event, filepath, content) => {
  try {
    // Validate path before writing file
    const validatedPath = validateLogPath(filepath);

    // Sanitize content to prevent potential issues
    if (typeof content !== 'string') {
      throw new Error('Content must be a string');
    }

    // Limit file size to prevent resource exhaustion
    const maxFileSize = 10 * 1024 * 1024; // 10MB
    if (content.length > maxFileSize) {
      throw new Error('File content exceeds maximum size limit');
    }

    await fs.promises.writeFile(validatedPath, content, 'utf8');
    return { success: true };
  } catch (error) {
    console.error('Error writing log file:', error);
    return { success: false, error: error.message };
  }
});

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 650,
    height: 600,
    title: 'Mic & Speaker Streamer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false
    }
  })

  mainWindow.loadFile('index.html')
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit()
})