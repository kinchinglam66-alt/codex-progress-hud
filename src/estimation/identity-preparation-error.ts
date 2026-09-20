/** Fixed local diagnostics only. Never retain a cause, RPC payload, or message. */
export const identityPreparationCodes = [
 'IDENTITY_HOME_PREPARE_FAILED','IDENTITY_RUNTIME_PREFLIGHT_FAILED','IDENTITY_ACCOUNT_READ_FAILED',
 'IDENTITY_HOME_RECHECK_FAILED','IDENTITY_BINDING_FAILED','IDENTITY_READY_FAILED',
 'IDENTITY_CANCELLED','IDENTITY_OWNERSHIP_UNCONFIRMED',
 'MAIN_METADATA_SOURCE_FAILED','MAIN_METADATA_TRANSPORT_FAILED','MAIN_METADATA_ROUTE_FAILED',
 'MAIN_METADATA_ACCOUNT_READ_FAILED','MAIN_METADATA_REVALIDATION_FAILED','MAIN_METADATA_TIMEOUT','MAIN_METADATA_CANCELLED',
 'MAIN_METADATA_CLOSE_UNCONFIRMED',
 'MAIN_AUTH_CREDENTIALS_FAILED','MAIN_AUTH_LOGIN_FAILED','MAIN_AUTH_RATE_LIMITS_FAILED',
 'MAIN_AUTH_IDENTITY_MISMATCH','MAIN_AUTH_REVALIDATION_FAILED','MAIN_AUTH_CANCELLED',
] as const;
export type IdentityPreparationCode = typeof identityPreparationCodes[number];
export function identityPreparationCode(error:unknown):IdentityPreparationCode|undefined {
 try {
  if (!(error instanceof Error)) return undefined;
  const code=Object.getOwnPropertyDescriptor(error,'code')?.value;
  return identityPreparationCodes.find(candidate=>candidate===code);
 } catch { return undefined; }
}
export function identityPreparationError(message:string,code:IdentityPreparationCode):Error {
 return Object.assign(new Error(message),{code});
}
