import './env.js'; // doit rester en premier (peuple process.env avant db/ai)
import { createApi } from './api.js';

const port = Number(process.env.API_PORT ?? 4000);
const app = createApi();

app.listen(port, () => {
  console.log(`Nova Comptabilité API → http://localhost:${port}`);
});
