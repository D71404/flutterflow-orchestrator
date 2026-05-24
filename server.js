import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import { exec } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

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

// Helper function to log to Supabase
async function logToSupabase(projectId, message, level = 'info') {
  try {
    const { error } = await supabase
      .from('build_logs')
      .insert({
        project_id: projectId,
        log_type: level,
        content: message,
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
          log_type: 'error',
          content: `Workspace not found. Please run /api/generate-mobile first to create the project workspace.`,
          created_at: new Date().toISOString()
        });
      return;
    }

    // Build and execute shell script
    const shellScript = `
      cd "${workspacePath}"

      # Run Claude Code CLI with the selected model
      echo "Running Claude Code CLI with model: ${selectedModel}"
      claude -p "${message}. Also, do not ask for confirmation." --model ${selectedModel} --yes
    `;

    // Execute the shell script
    exec(shellScript, {
      shell: '/bin/bash',
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
            log_type: 'chat_error',
            content: stderr || error.message,
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
            log_type: 'chat_success',
            content: stdout,
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
        log_type: 'chat_error',
        content: error.message,
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

    // Step 1: Create workspace directory
    await logToSupabase(projectId, `Creating workspace directory: ${workspacePath}`, 'info');
    await fs.mkdir(workspacePath, { recursive: true });
    await logToSupabase(projectId, 'Workspace directory created successfully', 'info');

    // Step 2: Clone the repository
    await logToSupabase(projectId, `Cloning repository from: ${lovableRepoUrl}`, 'info');

    await new Promise((resolve, reject) => {
      exec(`git clone "${lovableRepoUrl}" .`, {
        cwd: workspacePath,
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        timeout: 5 * 60 * 1000, // 5 minute timeout for clone
      }, async (error, stdout, stderr) => {
        if (error) {
          await logToSupabase(projectId, `Git clone failed: ${stderr || error.message}`, 'error');
          reject(error);
        } else {
          if (stdout) await logToSupabase(projectId, `Clone output: ${stdout}`, 'info');
          await logToSupabase(projectId, 'Repository cloned successfully', 'info');
          resolve();
        }
      });
    });

    // Step 3: Copy agent-environment folder if it exists
    const agentEnvPath = '/app/agent-environment/.claude';
    const localAgentEnvPath = path.join(__dirname, 'agent-environment', '.claude');

    try {
      // Try app path first, then local path
      try {
        await fs.access(agentEnvPath);
        await logToSupabase(projectId, 'Copying Claude skills from /app/agent-environment', 'info');
        await new Promise((resolve, reject) => {
          exec(`cp -r "${agentEnvPath}" "${workspacePath}/.claude"`, (error) => {
            if (error) reject(error);
            else resolve();
          });
        });
      } catch {
        // Fallback to local path
        await fs.access(localAgentEnvPath);
        await logToSupabase(projectId, 'Copying Claude skills from local agent-environment', 'info');
        await new Promise((resolve, reject) => {
          exec(`cp -r "${localAgentEnvPath}" "${workspacePath}/.claude"`, (error) => {
            if (error) reject(error);
            else resolve();
          });
        });
      }
      await logToSupabase(projectId, 'Claude skills copied successfully', 'info');
    } catch (err) {
      await logToSupabase(projectId, 'Warning: Could not copy Claude skills (continuing anyway)', 'warning');
    }

    // Step 4: Run Claude CLI
    await logToSupabase(projectId, 'Starting Claude Code translation...', 'info');

    const claudePrompt = 'Translate this web app into a FlutterFlow native app based on the SKILL.md rules. Do not ask for confirmation.';

    await new Promise((resolve, reject) => {
      const claudeCommand = `claude -p "${claudePrompt}" --yes`;

      exec(claudeCommand, {
        cwd: workspacePath,
        maxBuffer: 50 * 1024 * 1024, // 50MB buffer for Claude output
        timeout: 30 * 60 * 1000, // 30 minute timeout
        env: {
          ...process.env,
          FLUTTERFLOW_PROJECT: flutterflowId,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY
        }
      }, async (error, stdout, stderr) => {
        if (error) {
          await logToSupabase(projectId, `Claude execution failed: ${stderr || error.message}`, 'error');
          reject(error);
        } else {
          if (stdout) {
            // Split large output into chunks if needed
            const chunks = stdout.match(/.{1,5000}/g) || [];
            for (const chunk of chunks) {
              await logToSupabase(projectId, chunk, 'info');
            }
          }
          await logToSupabase(projectId, 'Translation completed successfully!', 'success');
          resolve();
        }
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
    // Log the exact error
    await logToSupabase(projectId, `Fatal error: ${error.message}`, 'error');

    // Update project status to 'failed'
    await supabase
      .from('projects')
      .update({ status: 'failed' })
      .eq('id', projectId);

    console.error(`Process failed for project ${projectId}:`, error);
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
  console.log('Required environment variables:');
  console.log('  - SUPABASE_URL');
  console.log('  - SUPABASE_SERVICE_KEY');
  console.log('  - ANTHROPIC_API_KEY (for chat features)');
});

export default app;