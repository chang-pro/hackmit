// NBA model module — thin re-export so the sports registry addresses every
// sport's model the same way (services/probability/models/<sport>.js). The
// implementation stays in services/probability/index.js, whose exports
// (estimate / winProbability / MODEL_VERSION) existing callers depend on.

export { winProbability, MODEL_VERSION } from "../index.js";
