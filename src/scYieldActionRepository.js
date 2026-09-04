import { TaYieldActionRepository } from './taYieldActionRepository.js';

// SC actions use the same SQL connection and record structure as TA actions, but a separate SC-only table.
export class ScYieldActionRepository extends TaYieldActionRepository {}
