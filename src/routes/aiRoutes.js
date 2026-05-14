import express from 'express';
import * as aiController from '../controllers/aiController.js';

const router = express.Router();

router.post('/chat', aiController.chat);
router.get('/health', aiController.healthCheck);
router.get('/templates', aiController.listTemplates);
router.get('/search', aiController.searchRooms);
router.get('/templates/:templateId', aiController.getTemplateById);

// Workspace registry
router.get('/workspaces', aiController.listWorkspaces);
router.get('/workspaces/:reqId', aiController.getWorkspace);
router.post('/workspaces/:reqId/save', aiController.saveWorkspace);
router.delete('/workspaces/:reqId', aiController.unsaveWorkspace);

// Agent memory
router.get('/memory', aiController.getMemory);
router.post('/memory', aiController.addMemoryNote);
router.delete('/memory/:target', aiController.clearMemory);

export default router;
