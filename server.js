import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const execAsync = promisify(exec);

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Global registry to track active build processes
const activeProcesses = new Map();

// Enable CORS for all origins
app.use(cors());

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Supabase client with service key for admin access
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.warn('Warning: SUPABASE_URL or SUPABASE_SERVICE_KEY not set. Some features will not work.');
}

const supabase = createClient(supabaseUrl || '', supabaseServiceKey || '', {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

// Initialize Anthropic client
const anthropicApiKey = process.env.ANTHROPIC_API_KEY;

if (!anthropicApiKey) {
  console.warn('Warning: ANTHROPIC_API_KEY not set. Chat features will not work.');
}

const anthropic = new Anthropic({
  apiKey: anthropicApiKey || ''
});

// Helper function to sanitize error messages (remove tokens)
function sanitizeError(message) {
  if (!message) return message;
  return String(message)
    .replace(/https:\/\/[^@\s]+@github\.com/g, 'https://***@github.com')
    .replace(/https:\/\/[^@\s]+@/g, 'https://***@');
}

// Helper function to log to Supabase
async function logToSupabase(projectId, message, level = 'info') {
  try {
    const { error } = await supabase
      .from('build_logs')
      .insert({
        project_id: projectId,
        level: level,
        line: message,
        created_at: new Date().toISOString()
      });

    if (error) {
      console.error('Failed to log to Supabase:', error);
    }
    console.log(`[${level.toUpperCase()}] Project ${projectId}: ${message}`);
  } catch (err) {
    console.error('Error in logToSupabase:', err);
  }
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Orchestration API is running',
    timestamp: new Date().toISOString()
  });
});

// API status endpoint
app.get('/api/status', (req, res) => {
  res.json({
    server: 'running',
    supabase: supabaseUrl ? 'configured' : 'not configured',
    environment: process.env.NODE_ENV || 'development'
  });
});

// AI Co-Pilot chat endpoint with Smart Router
app.post('/api/chat', async (req, res) => {
  try {
    const { projectId, message } = req.body;

    // Validate required parameters
    if (!projectId || !message) {
      return res.status(400).json({
        error: 'Missing required parameters',
        required: ['projectId', 'message']
      });
    }

    // 4. Smart Router Logic - Classify the request
    let selectedModel = 'claude-4-5-haiku-2025-01-22'; // Default to easy

    try {
      const classificationResponse = await anthropic.messages.create({
        model: 'claude-4-5-haiku-2025-01-22',
        max_tokens: 10,
        temperature: 0,
        system: 'You are a request classifier. Classify the following request as either "EASY" (color changes, text edits, padding), "NORMAL" (UI layouts, component changes, moderate logic), or "ADVANCED" (database logic, new pages, complex state, architecture). Return ONLY the word "EASY", "NORMAL", or "ADVANCED".',
        messages: [
          {
            role: 'user',
            content: message
          }
        ]
      });

      const classification = classificationResponse.content[0]?.text?.trim().toUpperCase();

      if (classification === 'NORMAL') {
        selectedModel = 'claude-4-5-sonnet-2025-01-20'; // Use Sonnet 4.5 for normal tasks
      } else if (classification === 'ADVANCED') {
        selectedModel = 'claude-4-5-opus-2025-01-20'; // Use Opus 4.5 for advanced tasks
      }

      console.log(`Chat request classified as ${classification}, using model: ${selectedModel}`);
    } catch (classificationError) {
      console.error('Classification error, defaulting to EASY:', classificationError);
    }

    // Return 200 OK immediately
    res.status(200).json({
      message: 'Chat processing started',
      projectId,
      model: selectedModel
    });

    // Execute in background
    processChatInBackground(projectId, message, selectedModel);

  } catch (error) {
    console.error('Error in /api/chat:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Stop build endpoint (Force Reset)
app.post('/api/stop-build', async (req, res) => {
  const { projectId } = req.body;

  // Validate required parameter
  if (!projectId) {
    return res.status(400).json({
      error: 'Missing required parameter',
      required: ['projectId']
    });
  }

  try {
    // If there's an active process, kill it
    if (activeProcesses.has(projectId)) {
      const childProcess = activeProcesses.get(projectId);

      try {
        childProcess.kill('SIGTERM');
        console.log(`Killed active process for project ${projectId}`);
      } catch (killError) {
        console.error(`Failed to kill process for project ${projectId}:`, killError);
      }

      // Remove from registry
      activeProcesses.delete(projectId);
    }

    // ALWAYS log warning to Supabase (regardless of process state)
    await logToSupabase(projectId, '[WARNING] Build forcefully reset by user', 'warning');

    // ALWAYS update project status to 'draft' (regardless of process state)
    await supabase
      .from('projects')
      .update({ status: 'draft' })
      .eq('id', projectId);

    // ALWAYS return 200 OK
    res.status(200).json({
      message: 'Build forcefully reset',
      projectId,
      status: 'draft',
      processWasActive: activeProcesses.has(projectId)
    });
  } catch (error) {
    console.error('Error in force reset:', error);

    // Even on error, try to update status and return 200
    try {
      await supabase
        .from('projects')
        .update({ status: 'draft' })
        .eq('id', projectId);
    } catch (dbError) {
      console.error('Failed to update database:', dbError);
    }

    res.status(200).json({
      message: 'Build reset attempted (with errors)',
      projectId,
      status: 'draft',
      error: error.message
    });
  }
});

// Mobile app generation endpoint
app.post('/api/generate-mobile', async (req, res) => {
  const { projectId, lovableRepoUrl, flutterflowId } = req.body;

  // Validate required parameters
  if (!projectId || !lovableRepoUrl || !flutterflowId) {
    return res.status(400).json({
      error: 'Missing required parameters',
      required: ['projectId', 'lovableRepoUrl', 'flutterflowId']
    });
  }

  // Immediately return 200 OK to unblock the frontend
  res.status(200).json({
    message: 'Mobile generation process has started',
    projectId,
    status: 'processing'
  });

  // All work happens asynchronously in the background
  processInBackground(projectId, lovableRepoUrl, flutterflowId);
});

// Chat background processing function
async function processChatInBackground(projectId, message, selectedModel) {
  const workspacePath = `/tmp/workspaces/${projectId}`;

  try {
    console.log(`Starting chat processing for project ${projectId} with model ${selectedModel}`);

    // Check if workspace exists
    try {
      await fs.access(workspacePath);
    } catch {
      console.error(`Workspace not found for project ${projectId}`);
      await supabase
        .from('build_logs')
        .insert({
          project_id: projectId,
          level: 'error',
          line: `Workspace not found. Please run /api/generate-mobile first to create the project workspace.`,
          created_at: new Date().toISOString()
        });
      return;
    }

    // Build and execute shell script
    const shellScript = `
      cd "${workspacePath}"

      # Run Claude Code CLI with the selected model
      echo "Running Claude Code CLI with model: ${selectedModel}"
      claude -p "${message}. Also, do not ask for confirmation." --model ${selectedModel} --dangerously-skip-permissions
    `;

    // Execute the shell script
    exec(shellScript, {
      shell: '/bin/bash',
      uid: 1000,
      gid: 1000,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      timeout: 15 * 60 * 1000, // 15 minute timeout
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY
      }
    }, async (error, stdout, stderr) => {

      // Handle execution results
      if (error) {
        console.error(`Chat execution failed for project ${projectId}:`, error);

        // Insert error log
        await supabase
          .from('build_logs')
          .insert({
            project_id: projectId,
            level: 'chat_error',
            line: stderr || error.message,
            created_at: new Date().toISOString()
          });

        console.log(`Chat request failed for project ${projectId}`);
      } else {
        console.log(`Chat execution succeeded for project ${projectId}`);

        // Insert success log
        await supabase
          .from('build_logs')
          .insert({
            project_id: projectId,
            level: 'chat_success',
            line: stdout,
            created_at: new Date().toISOString()
          });

        console.log(`Chat request completed for project ${projectId}`);
      }
    });

  } catch (error) {
    console.error(`Chat processing error for project ${projectId}:`, error);

    // Insert error log
    await supabase
      .from('build_logs')
      .insert({
        project_id: projectId,
        level: 'chat_error',
        line: error.message,
        created_at: new Date().toISOString()
      });
  }
}

// Background processing function
async function processInBackground(projectId, lovableRepoUrl, flutterflowId) {
  const workspacePath = `/tmp/workspaces/${projectId}`;

  try {
    // Update project status to 'translating'
    await supabase
      .from('projects')
      .update({ status: 'translating' })
      .eq('id', projectId);

    // Log initialization
    await logToSupabase(projectId, 'Initializing build environment...', 'info');

    // Step 1: Clean and create workspace directory
    await logToSupabase(projectId, `Preparing workspace directory: ${workspacePath}`, 'info');

    // Delete existing workspace if it exists (from previous failed runs)
    await fs.rm(workspacePath, { recursive: true, force: true });

    // Create fresh workspace
    await fs.mkdir(workspacePath, { recursive: true });
    await logToSupabase(projectId, 'Workspace directory created successfully', 'info');

    // Step 2: Clone the repository
    await logToSupabase(projectId, `Cloning repository from: ${lovableRepoUrl}`, 'info');

    // Add GitHub token authentication if available
    let cloneUrl = lovableRepoUrl;
    if (process.env.GITHUB_TOKEN) {
      try {
        const url = new URL(lovableRepoUrl);
        if (url.hostname === 'github.com') {
          // Inject token into the URL for authentication
          url.username = process.env.GITHUB_TOKEN;
          cloneUrl = url.toString();
          await logToSupabase(projectId, 'Using GitHub token for authentication', 'info');
        }
      } catch (urlError) {
        await logToSupabase(projectId, `Warning: Could not parse repository URL: ${urlError.message}`, 'warning');
      }
    }

    await new Promise((resolve, reject) => {
      exec(`git clone "${cloneUrl}" .`, {
        cwd: workspacePath,
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        timeout: 5 * 60 * 1000, // 5 minute timeout for clone
      }, async (error, stdout, stderr) => {
        if (error) {
          // Sanitize all error messages to not expose token
          const sanitizedStderr = sanitizeError(stderr);
          const sanitizedErrorMsg = sanitizeError(error.message);
          const sanitizedStack = sanitizeError(error.stack);

          await logToSupabase(projectId, `Git clone failed: ${sanitizedStderr || sanitizedErrorMsg}`, 'error');

          // Create sanitized error to reject with
          const sanitizedError = new Error(sanitizedErrorMsg);
          sanitizedError.stack = sanitizedStack;
          reject(sanitizedError);
        } else {
          if (stdout) {
            const sanitizedStdout = sanitizeError(stdout);
            await logToSupabase(projectId, `Clone output: ${sanitizedStdout}`, 'info');
          }
          await logToSupabase(projectId, 'Repository cloned successfully', 'info');
          resolve();
        }
      });
    });

    // Step 2.5: Change ownership to non-root user (UID 1000)
    await logToSupabase(projectId, 'Changing workspace ownership to UID 1000...', 'info');
    try {
      await execAsync('chown -R 1000:1000 .', { cwd: workspacePath });
      await logToSupabase(projectId, 'Ownership changed successfully', 'info');
    } catch (chownError) {
      await logToSupabase(projectId, `Warning: Could not change ownership: ${chownError.message}`, 'warning');
    }

    // Step 3: Copy SKILL.md rulebook to workspace
    await logToSupabase(projectId, 'Copying SKILL.md rulebook...', 'info');

    try {
      // Build path to SKILL.md - try production path first, then local
      const productionSkillPath = '/app/agent-environment/skills/lovable-to-flutterflow/SKILL.md';
      const localSkillPath = path.join(__dirname, 'agent-environment', 'skills', 'lovable-to-flutterflow', 'SKILL.md');
      const destinationPath = path.join(workspacePath, 'SKILL.md');

      let skillPath;
      try {
        await fs.access(productionSkillPath);
        skillPath = productionSkillPath;
        await logToSupabase(projectId, 'Using production SKILL.md path', 'info');
      } catch {
        await fs.access(localSkillPath);
        skillPath = localSkillPath;
        await logToSupabase(projectId, 'Using local SKILL.md path', 'info');
      }

      // Copy the SKILL.md file to workspace root
      await fs.copyFile(skillPath, destinationPath);
      await logToSupabase(projectId, 'SKILL.md copied successfully', 'info');
    } catch (err) {
      await logToSupabase(projectId, `Warning: Could not copy SKILL.md: ${err.message}`, 'warning');
    }

    // Step 4: Run Claude CLI with streaming output
    await logToSupabase(projectId, 'Starting Claude Code translation...', 'info');

    const claudePrompt = 'Translate this web app into a FlutterFlow native app based on the SKILL.md rules. Do not ask for confirmation.';

    await new Promise((resolve, reject) => {
      // Build the full command as a single string for shell: true
      const claudeCommand = `claude -p "${claudePrompt}" --dangerously-skip-permissions`;

      await logToSupabase(projectId, `Executing command: ${claudeCommand}`, 'info');

      // Use spawn with stdin closed and CI mode enabled
      const childProcess = spawn(claudeCommand, [], {
        cwd: workspacePath,
        uid: 1000,
        gid: 1000,
        shell: '/bin/bash',
        stdio: ['ignore', 'pipe', 'pipe'], // Close stdin, pipe stdout/stderr
        env: {
          ...process.env,
          FLUTTERFLOW_PROJECT: flutterflowId,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
          CI: 'true', // Force headless CI mode
          FORCE_COLOR: '0', // Disable ANSI color codes
          PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' // Ensure PATH is set
        }
      });

      // Log that process was spawned
      await logToSupabase(projectId, `Process spawned with PID: ${childProcess.pid}`, 'info');

      // Store process in registry for potential cancellation
      activeProcesses.set(projectId, childProcess);

      // Check if process spawned successfully
      if (!childProcess.pid) {
        await logToSupabase(projectId, 'Failed to spawn Claude process - no PID assigned', 'error');
        reject(new Error('Failed to spawn Claude process'));
        return;
      }

      // Use readline for line-buffered stdout streaming
      const stdoutInterface = readline.createInterface({
        input: childProcess.stdout,
        crlfDelay: Infinity
      });

      stdoutInterface.on('line', async (line) => {
        if (line.trim()) {
          await logToSupabase(projectId, line, 'info');
        }
      });

      // Use readline for line-buffered stderr streaming
      const stderrInterface = readline.createInterface({
        input: childProcess.stderr,
        crlfDelay: Infinity
      });

      stderrInterface.on('line', async (line) => {
        if (line.trim()) {
          await logToSupabase(projectId, `[stderr] ${line}`, 'warning');
        }
      });

      // Add spawn event handler to catch immediate failures
      childProcess.on('spawn', async () => {
        await logToSupabase(projectId, 'Claude process spawned successfully', 'info');
      });

      // Handle process exit
      childProcess.on('close', async (code) => {
        // Clean up readline interfaces
        stdoutInterface.close();
        stderrInterface.close();

        // Remove from active processes registry
        activeProcesses.delete(projectId);

        if (code === 0) {
          await logToSupabase(projectId, 'Translation completed successfully!', 'success');
          resolve();
        } else {
          await logToSupabase(projectId, `Claude process exited with code ${code}`, 'error');
          reject(new Error(`Process exited with code ${code}`));
        }
      });

      // Handle process errors
      childProcess.on('error', async (error) => {
        // Clean up readline interfaces
        stdoutInterface.close();
        stderrInterface.close();

        // Remove from active processes registry
        activeProcesses.delete(projectId);

        await logToSupabase(projectId, `Claude process error: ${error.message}`, 'error');
        reject(error);
      });
    });

    // Update project status to 'completed'
    await supabase
      .from('projects')
      .update({ status: 'completed' })
      .eq('id', projectId);

    await logToSupabase(projectId, 'Project completed successfully', 'success');

    // Clean up workspace
    try {
      await fs.rm(workspacePath, { recursive: true, force: true });
      await logToSupabase(projectId, 'Workspace cleaned up', 'info');
    } catch (cleanupError) {
      await logToSupabase(projectId, `Warning: Could not clean up workspace: ${cleanupError.message}`, 'warning');
    }

  } catch (error) {
    // Clean up from active processes registry
    activeProcesses.delete(projectId);

    // Sanitize and log the error
    const sanitizedMessage = sanitizeError(error.message);
    const sanitizedStack = sanitizeError(error.stack);

    await logToSupabase(projectId, `Fatal error: ${sanitizedMessage}`, 'error');

    // Update project status to 'failed'
    await supabase
      .from('projects')
      .update({ status: 'failed' })
      .eq('id', projectId);

    // Console log with sanitized error
    console.error(`Process failed for project ${projectId}:`, sanitizedMessage);
    if (sanitizedStack) {
      console.error('Stack trace:', sanitizedStack);
    }
  }
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: 'Something went wrong!',
    message: err.message
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Orchestration server is running on http://localhost:${PORT}`);
  console.log('Environment:', process.env.NODE_ENV || 'development');
  console.log('Supabase URL:', supabaseUrl ? 'Configured' : 'Not configured');
  console.log('Supabase Service Key:', supabaseServiceKey ? 'Configured' : 'Not configured');
  console.log('Anthropic API Key:', anthropicApiKey ? 'Configured' : 'Not configured');
  console.log('GitHub Token:', process.env.GITHUB_TOKEN ? 'Configured' : 'Not configured');
  console.log('Required environment variables:');
  console.log('  - SUPABASE_URL');
  console.log('  - SUPABASE_SERVICE_KEY');
  console.log('  - ANTHROPIC_API_KEY (for chat features)');
  console.log('  - GITHUB_TOKEN (optional, for private repos)');
});

export default app;