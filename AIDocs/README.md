# AIDocs - Multi-Agent Development Documentation System

## Overview
This directory contains the documentation structure for coordinating multi-agent development workflows.

## Directory Structure

### `/features`
Main feature documents tracking development from initial request to completion.
- File naming: `FT-YYYY-MM-DD-XXX-[brief-description].md`
- Contains complete feature lifecycle documentation

### `/agents-buffer`
Inter-agent message exchange files for coordination between agents.
- Used for passing context between PM, Developer, Researcher, Designer, and QA agents
- Files are created, processed, and cleared as part of the workflow

### `/templates`
Standard document templates for consistent communication:
- `feature-document-template.md` - Complete feature documentation structure
- `pm-to-researcher.md` - Research coordination template
- `pm-to-designer.md` - Design coordination template
- `pm-to-developer.md` - Development implementation template
- `pm-to-qa.md` - QA testing coordination template
- `developer-to-pm.md` - Developer analysis template

### `/archive`
Completed tasks and historical documentation.
- `/completed` - Successfully finished features
- Organized for reference and retrospective analysis

## Workflow Process

1. **User Request** → Developer Agent analyzes complexity
2. **Developer** → PM Agent creates feature document
3. **PM Agent** routes based on complexity:
   - **Micro** (< 2h) → Direct to User Approval
   - **Minor** (2-16h) → Designer Agent
   - **Major** (> 16h) → Researcher Agent
4. **Research/Design** → PM Agent consolidates findings
5. **User Approval** → Developer implements
6. **Development** → QA Agent tests
7. **QA Complete** → PM Agent finalizes and archives

## Status Management

**Feature Document Statuses:**
Draft → Research → Design → Pending Approval → Approved → Development → QA → Bug Fixes → Done

**Buffer File Lifecycle:**
Ready → Processing → Complete → Error (requires intervention)

## Critical Rules

- Always update Feature Document after agent interactions
- Use standardized buffer files for agent communication
- Maintain complete traceability from request to delivery
- Document all decisions with reasoning in Decision Log
- Verify completeness before agent handoffs