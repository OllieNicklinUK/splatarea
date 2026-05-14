---
description: Assign a task to the local VIVERSE AI Agent
---

1. Ensure the server is running (use `/viverse-agent-start` if not).
2. Use the `curl` command to send your task to the agent:
```bash
curl -X POST http://localhost:3000/api/ai/chat \
-H "Content-Type: application/json" \
-d '{"message": "INSERT_YOUR_TASK_HERE"}'
```

Replace `INSERT_YOUR_TASK_HERE` with your specific request (e.g., "Add a VIVERSE login button to the App.jsx in voxel_landmark").
