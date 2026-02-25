/**
 * Utilidades para manejo de fechas
 * Especialmente para normalizar fechas provenientes de ERPNext
 */

/**
 * Normaliza datetime de ERPNext (microsegundos) a formato JavaScript (milisegundos)
 * ERPNext envía: 2026-02-24T15:12:58.715809 (6 dígitos = microsegundos)
 * JavaScript espera: 2026-02-24T15:12:58.715Z (3 dígitos = milisegundos)
 * 
 * @param {string|Date} datetimeStr - String o objeto Date a normalizar
 * @param {boolean} formatoSIFEN - Si es true, devuelve formato SIFEN (sin milisegundos ni Z)
 * @returns {string} Fecha normalizada en formato ISO o SIFEN
 */
function normalizarDatetime(datetimeStr, formatoSIFEN = false) {
  if (!datetimeStr) return new Date().toISOString();

  // Si ya es un objeto Date, convertir a ISO
  if (datetimeStr instanceof Date) {
    const iso = datetimeStr.toISOString();
    return formatoSIFEN ? iso.replace(/\.\d{3}Z$/, '') : iso;
  }

  // Si es número (timestamp), convertir a Date
  if (typeof datetimeStr === 'number') {
    const date = new Date(datetimeStr);
    const iso = date.toISOString();
    return formatoSIFEN ? iso.replace(/\.\d{3}Z$/, '') : iso;
  }

  // Si es string, procesar
  if (typeof datetimeStr === 'string') {
    // Patrón para detectar datetime con microsegundos: YYYY-MM-DDTHH:MM:SS.ffffff
    const matchMicrosegundos = datetimeStr.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})(.*)$/);

    if (matchMicrosegundos) {
      // Convertir microsegundos a milisegundos (cortar últimos 3 dígitos)
      const [, parteBase, microsegundos, resto] = matchMicrosegundos;
      const milisegundos = microsegundos.substring(0, 3);
      const resultado = `${parteBase}.${milisegundos}${resto || 'Z'}`;
      return formatoSIFEN ? resultado.replace(/\.\d{3}Z$/, '') : resultado;
    }

    // Si no tiene microsegundos, intentar parsear directamente
    try {
      const date = new Date(datetimeStr);
      if (!isNaN(date.getTime())) {
        const iso = date.toISOString();
        return formatoSIFEN ? iso.replace(/\.\d{3}Z$/, '') : iso;
      }
    } catch (e) {
      console.warn(`⚠️ Fecha inválida: ${datetimeStr}`);
    }
  }

  // Fallback: devolver fecha actual
  const now = new Date();
  const iso = now.toISOString();
  return formatoSIFEN ? iso.replace(/\.\d{3}Z$/, '') : iso;
}

/**
 * Normaliza todas las fechas en un objeto de factura de ERPNext
 * Busca recursivamente campos de fecha y los normaliza
 * 
 * @param {Object} obj - Objeto a procesar
 * @returns {Object} Objeto con fechas normalizadas
 */
function normalizarFechasEnObjeto(obj) {
  if (!obj || typeof obj !== 'object') return obj;

  const camposFecha = ['fecha', 'fecha_nacimiento', 'fecha_emision', 'fecha_vencimiento', 'created', 'modified'];

  for (const key in obj) {
    if (obj.hasOwnProperty(key)) {
      const value = obj[key];

      // Si es un campo de fecha conocido
      if (camposFecha.includes(key) && (typeof value === 'string' || typeof value === 'number' || value instanceof Date)) {
        obj[key] = normalizarDatetime(value);
      }
      // Si es un objeto o array, procesar recursivamente
      else if (value && typeof value === 'object') {
        normalizarFechasEnObjeto(value);
      }
    }
  }

  return obj;
}

/**
 * Obtiene fecha en formato SIFEN v150 (YYYY-MM-DDTHH:MM:SS sin milisegundos ni Z)
 * @param {string|Date} fecha - Fecha a convertir
 * @returns {string} Fecha en formato SIFEN
 */
function formatoFechaSIFEN(fecha) {
  return normalizarDatetime(fecha, true);
}

/**
 * Valida si una fecha es válida
 * @param {string|Date} fecha - Fecha a validar
 * @returns {boolean} True si es válida
 */
function esFechaValida(fecha) {
  if (!fecha) return false;
  
  try {
    const date = new Date(fecha);
    return !isNaN(date.getTime());
  } catch (e) {
    return false;
  }
}

module.exports = {
  normalizarDatetime,
  normalizarFechasEnObjeto,
  formatoFechaSIFEN,
  esFechaValida
};
