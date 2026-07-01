// Charge les variables d'environnement depuis .env.local puis .env.
// Importé EN PREMIER par index.ts pour que les modules (db, ai…) lisent
// process.env déjà peuplé. dotenv n'écrase pas les variables déjà définies.
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();
