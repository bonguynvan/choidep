// Startup checks: production must never fall back to request headers for its own URL.

/**
 * What is missing or unsafe in a production environment (empty list = fine).
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function productionProblems(env) {
  if (env.NODE_ENV !== 'production') return [];
  const problems = [];
  if (!String(env.PUBLIC_URL ?? '').startsWith('https://')) {
    problems.push('PUBLIC_URL phải là địa chỉ https (VD https://choidep.peti.vn): dùng cho link chia sẻ và mã QR.');
  }
  return problems;
}
