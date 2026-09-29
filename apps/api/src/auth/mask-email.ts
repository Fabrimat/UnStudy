// Emails are PII: mask before logging, e.g. 'f***@larosa.work'. Never reveals a 1-char local part.
export function maskEmail(email: string) {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${at > 1 ? email[0] : ''}***@${email.slice(at + 1)}`;
}
