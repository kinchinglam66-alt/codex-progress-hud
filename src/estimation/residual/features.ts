import {featuresSchema,type Features} from './contract.js';

/** Fixed model input order. Masks retain null-vs-zero until training imputation. */
export function vectorize(value:Features):readonly number[] {
  const f=featuresSchema.parse(value);
  return Object.freeze([
    ...[f.rawSeconds,f.elapsedActiveSeconds,f.observedActiveSeconds,f.oldestActionActiveSeconds,
      f.outstandingActions,f.completedActions,f.failedActions].map(x=>x===null?0:Math.log1p(x)),
    Number(f.elapsedActiveSeconds===null),Number(f.oldestActionActiveSeconds===null),Number(f.prefixComplete),
  ]);
}
