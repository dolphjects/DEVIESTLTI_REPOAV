'use strict';

const fs = require('fs');
const path = require('path');

let cachedPath = null;
let cachedData = {};

function clampPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function loadTimingData() {
  const configuredPath = process.env.PRO_PROGRESS_FILE;
  if (!configuredPath) return {};

  const absolutePath = path.resolve(configuredPath);
  if (absolutePath === cachedPath) return cachedData;

  try {
    cachedData = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
    cachedPath = absolutePath;
  } catch (error) {
    console.warn(`No se pudo cargar PRO_PROGRESS_FILE (${absolutePath}): ${error.message}`);
    cachedData = {};
    cachedPath = absolutePath;
  }

  return cachedData;
}

/**
 * Adaptador único para el desglose PRO.
 *
 * Llave esperada en el JSON:
 *   "courseId:studentId:moduleId": { "atClose": 70, "afterClose": 20 }
 *
 * IMPORTANTE:
 * Canvas Modules entrega el estado actual de cumplimiento, pero no siempre una
 * marca de tiempo por cada requisito completado. Mientras no exista una fuente
 * histórica, el fallback coloca el avance actual en "al cierre" y deja 0 en
 * "posterior". Sustituye este proveedor por tu BD/snapshot cuando esté lista.
 */
function resolveProgressTiming({ courseId, studentId, moduleId, currentPct }) {
  const total = clampPercent(currentPct);
  const data = loadTimingData();
  const key = `${courseId}:${studentId}:${moduleId}`;
  const record = data[key];

  if (record) {
    const atClose = Math.min(clampPercent(record.atClose), total);
    const afterClose = Math.min(
      clampPercent(record.afterClose),
      Math.max(total - atClose, 0)
    );

    return {
      atClose,
      afterClose,
      timingAvailable: true,
      timingSource: 'configured-history'
    };
  }

  return {
    atClose: total,
    afterClose: 0,
    timingAvailable: false,
    timingSource: 'current-total-fallback'
  };
}

module.exports = {
  resolveProgressTiming
};
