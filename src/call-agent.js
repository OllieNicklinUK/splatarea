#!/usr/bin/env node

/**
 * call-agent.js
 * CLI tool for robust communication with the VIVERSE AI Agent with persistence.
 */

import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENDPOINT = "http://localhost:3000/api/ai/chat";
const HISTORY_FILE = path.join(process.cwd(), ".viverse_history.json");

async function run() {
    const args = process.argv.slice(2);

    let isNewSession = false;
    let messageArgs = args;

    if (args[0] === "--new" || args[0] === "-n") {
        isNewSession = true;
        messageArgs = args.slice(1);
    }

    if (messageArgs.length === 0) {
        console.log("Usage: node call-agent.js [--new] \"Your task message\"");
        console.log("Example: node call-agent.js \"Check App.jsx for bugs\"");
        console.log("Example: node call-agent.js --new \"Start a fresh task\"");
        process.exit(0);
    }

    const message = messageArgs.join(" ");

    // Handle history
    let history = [];
    if (!isNewSession && fs.existsSync(HISTORY_FILE)) {
        try {
            history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            console.log(`📜 Loaded ${history.length / 2} previous turns of history.`);
        } catch (e) {
            console.warn("⚠️ Failed to load history, starting fresh.");
        }
    } else if (isNewSession) {
        console.log("🆕 Starting a new session (history cleared).");
        if (fs.existsSync(HISTORY_FILE)) fs.unlinkSync(HISTORY_FILE);
    }

    console.log("🚀 Sending task to VIVERSE Agent (streaming enabled)...");

    try {
        const response = await axios.post(ENDPOINT, {
            message,
            history,
            stream: true
        }, {
            headers: { 'Content-Type': 'application/json' },
            responseType: 'stream',
            timeout: 300000 // 5 minute timeout
        });

        console.log("\n✅ Agent Response:\n");
        let fullReply = "";

        response.data.on('data', (data) => {
            const lines = data.toString().split('\n');
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const content = line.substring(6).trim();
                    if (content === '[DONE]') {
                        return;
                    }

                    try {
                        const chunk = JSON.parse(content);
                        if (chunk.type === 'text') {
                            process.stdout.write(chunk.content);
                            fullReply += chunk.content;
                        } else if (chunk.type === 'status') {
                            process.stdout.write(`\n🔍 ${chunk.content}\n`);
                        } else if (chunk.type === 'error') {
                            console.error(`\n❌ Agent Error: ${chunk.content}`);
                        }
                    } catch (e) {
                        // Not valid JSON or partial chunk
                    }
                }
            }
        });

        response.data.on('end', () => {
            // Update and save history
            const newHistory = [
                ...history,
                { role: 'user', parts: [{ text: message }] },
                { role: 'model', parts: [{ text: fullReply }] }
            ];

            // Keep history manageable (last 10 turns)
            const trimmedHistory = newHistory.slice(-20);
            fs.writeFileSync(HISTORY_FILE, JSON.stringify(trimmedHistory, null, 2));

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const outputFile = path.join(process.cwd(), `agent_response_${timestamp}.json`);
            fs.writeFileSync(outputFile, JSON.stringify({ success: true, reply: fullReply }, null, 2));

            console.log(`\n\n💾 History updated in ${HISTORY_FILE}`);
            console.log(`💾 Full response saved to ${outputFile}`);
            console.log("🏁 Task Complete.");
        });

    } catch (error) {
        if (error.code === 'ECONNREFUSED') {
            console.error("❌ Error: Could not connect to the VIVERSE Agent server. Is it running on port 3000?");
        } else {
            console.error("❌ Error calling Agent:", error.message);
        }
    }
}

run();
