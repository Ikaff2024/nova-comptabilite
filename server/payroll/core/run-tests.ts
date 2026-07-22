// Lanceur des tests du moteur de paie (portés d'IvoirePaie payroll-core).
// `npm run test:payroll` — sort en code 1 si un barème régresse.
import { report } from './testkit';

import './rules.test';
import './engine.golden.test';
import './allocationSpeciale.test';
import './overtime.test';
import './absences.test';
import './loans.test';
import './stc.test';

report();
