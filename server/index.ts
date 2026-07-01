import './env.js'; // doit rester en premier (peuple process.env avant db/ai)
import { createApi } from './api.js';

// Railway/Render fournissent PORT ; fallback local API_PORT puis 4000.
const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4000);
const app = createApi();

app.listen(port, () => {
  console.log(`Nova Comptabilité API → port ${port}`);
});
