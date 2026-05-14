import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import app from './app.js';
import logger from './utils/logger.js';

// Always run from the project root so all process.cwd() paths resolve correctly
const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(__filename), '..');
process.chdir(PROJECT_ROOT);

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
    logger.info(`Viverse AI Agent Server is running on http://${HOST}:${PORT}`);
    if (HOST === '0.0.0.0') {
        logger.info('External access is enabled. Access via your network IP.');
    }
});
