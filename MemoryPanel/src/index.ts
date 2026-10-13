// Unified entry: start the stateless panel directly (path A).
// Legacy path B has been removed; the PANEL_MODE fork is no longer needed.
import { config as loadDotenv } from 'dotenv';
loadDotenv();

import { main } from './panel/index.js';
main();
