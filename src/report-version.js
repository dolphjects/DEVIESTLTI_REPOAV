'use strict';

const VALID_VERSIONS = new Set(['basic', 'pro']);

function normalizeId(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';

  const accountMatch = text.match(/\/accounts\/(\d+)/i);
  if (accountMatch) return accountMatch[1];

  const courseMatch = text.match(/\/courses\/(\d+)/i);
  if (courseMatch) return courseMatch[1];

  return text;
}

function parseIdList(value = '') {
  return new Set(
    String(value)
      .split(',')
      .map(normalizeId)
      .filter(Boolean)
  );
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'si', 'sí', 'on'].includes(String(value).trim().toLowerCase());
}

function normalizeVersion(value, fallback = 'basic') {
  const normalized = String(value || '').trim().toLowerCase().replace('version_', '');
  return VALID_VERSIONS.has(normalized) ? normalized : fallback;
}

function collectAccountIds(accountId, accountIds = []) {
  const values = Array.isArray(accountIds) ? accountIds : [accountIds];
  if (accountId !== undefined && accountId !== null) values.push(accountId);
  return new Set(values.map(normalizeId).filter(Boolean));
}

function intersects(left, right) {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

/**
 * Único punto de decisión entre VERSION_PRO y VERSION_BASIC.
 *
 * Variables disponibles:
 * - DEFAULT_REPORT_VERSION=basic|pro
 * - BASIC_COURSE_IDS=123,456
 * - PRO_COURSE_IDS=789,900
 * - BASIC_ACCOUNT_IDS=113,121
 * - PRO_ACCOUNT_IDS=105
 * - ALLOW_REPORT_VERSION_OVERRIDE=true|false
 *
 * accountIds puede contener la subcuenta inmediata y toda su línea de padres.
 * De esta forma, un curso dentro de una subcuenta hija también hereda la versión
 * configurada para la subcuenta principal.
 */
function resolveReportVersion({ courseId, accountId, accountIds = [], requestedVersion } = {}) {
  const defaultVersion = normalizeVersion(process.env.DEFAULT_REPORT_VERSION, 'basic');
  const allowOverride = parseBoolean(
    process.env.ALLOW_REPORT_VERSION_OVERRIDE,
    process.env.NODE_ENV !== 'production'
  );

  if (allowOverride && requestedVersion) {
    return normalizeVersion(requestedVersion, defaultVersion);
  }

  const normalizedCourseId = normalizeId(courseId);
  const courseAccountIds = collectAccountIds(accountId, accountIds);

  const proCourseIds = parseIdList(process.env.PRO_COURSE_IDS);
  const basicCourseIds = parseIdList(process.env.BASIC_COURSE_IDS);
  const proAccountIds = parseIdList(process.env.PRO_ACCOUNT_IDS);
  const basicAccountIds = parseIdList(process.env.BASIC_ACCOUNT_IDS);

  // La versión Pro tiene prioridad si por error un ID aparece en ambas listas.
  if (normalizedCourseId && proCourseIds.has(normalizedCourseId)) return 'pro';
  if (normalizedCourseId && basicCourseIds.has(normalizedCourseId)) return 'basic';
  if (intersects(courseAccountIds, proAccountIds)) return 'pro';
  if (intersects(courseAccountIds, basicAccountIds)) return 'basic';

  return defaultVersion;
}

module.exports = {
  normalizeId,
  normalizeVersion,
  resolveReportVersion
};
