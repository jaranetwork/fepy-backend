/**
 * Servicio para gestión de certificados digitales
 * Maneja el almacenamiento y cifrado de certificados .p12 por RUC
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Ruta base de certificados (desde variables de entorno o default)
const CERTIFICADOS_BASE_PATH = process.env.CERTIFICADOS_PATH || 
  path.join(__dirname, '../certificados');

/**
 * Crea carpeta para un RUC
 * @param {string} ruc - RUC de la empresa
 * @returns {string} Ruta de la carpeta creada
 */
function crearCarpetaRuc(ruc) {
  const carpeta = path.join(CERTIFICADOS_BASE_PATH, ruc);
  if (!fs.existsSync(carpeta)) {
    fs.mkdirSync(carpeta, { recursive: true });
    console.log(`📁 Carpeta creada para RUC ${ruc}: ${carpeta}`);
  }
  return carpeta;
}

/**
 * Obtiene ruta del certificado para un RUC
 * @param {string} ruc - RUC de la empresa
 * @returns {string} Ruta completa al archivo .p12
 */
function obtenerRutaCertificado(ruc) {
  return path.join(CERTIFICADOS_BASE_PATH, ruc, 'certificado.p12');
}

/**
 * Guarda certificado .p12 en el filesystem
 * @param {string} ruc - RUC de la empresa
 * @param {Buffer} buffer - Contenido del archivo .p12
 * @returns {string} Ruta donde se guardó el archivo
 */
function guardarCertificado(ruc, buffer) {
  // Crear directorio si no existe
  const carpeta = path.join(CERTIFICADOS_BASE_PATH, ruc);
  if (!fs.existsSync(carpeta)) {
    fs.mkdirSync(carpeta, { recursive: true });
    console.log(`📁 Carpeta creada para RUC ${ruc}: ${carpeta}`);
  }
  
  const ruta = obtenerRutaCertificado(ruc);
  fs.writeFileSync(ruta, buffer);
  console.log(`✅ Certificado guardado para RUC ${ruc}: ${ruta}`);
  return ruta;
}

/**
 * Elimina certificado y carpeta de un RUC
 * @param {string} ruc - RUC de la empresa
 */
function eliminarCertificado(ruc) {
  const carpeta = path.join(CERTIFICADOS_BASE_PATH, ruc);
  if (fs.existsSync(carpeta)) {
    fs.rmSync(carpeta, { recursive: true, force: true });
    console.log(`🗑️ Certificado eliminado para RUC ${ruc}`);
  }
}

/**
 * Cifra contraseña con AES-256-CBC
 * @param {string} contrasena - Contraseña a cifrar
 * @returns {string} Contraseña cifrada en formato hex:iv
 */
function cifrarContrasena(contrasena) {
  const masterKey = Buffer.from(
    (process.env.CERTIFICADO_MASTER_KEY || 'default-key-32-chars!!').padEnd(32, '0').slice(0, 32),
    'utf8'
  );
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', masterKey, iv);
  
  let encrypted = cipher.update(contrasena, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  return iv.toString('hex') + ':' + encrypted;
}

/**
 * Descifra contraseña cifrada con AES-256-CBC
 * @param {string} encrypted - Contraseña cifrada en formato hex:iv
 * @returns {string} Contraseña descifrada en texto plano
 */
function descifrarContrasena(encrypted) {
  const masterKey = Buffer.from(
    (process.env.CERTIFICADO_MASTER_KEY || 'default-key-32-chars!!').padEnd(32, '0').slice(0, 32),
    'utf8'
  );
  const [ivHex, encryptedHex] = encrypted.split(':');
  
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', masterKey, iv);
  
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

/**
 * Verifica si existe certificado para un RUC
 * @param {string} ruc - RUC de la empresa
 * @returns {boolean} true si existe el certificado
 */
function existeCertificado(ruc) {
  return fs.existsSync(obtenerRutaCertificado(ruc));
}

/**
 * Obtiene información del certificado (sin el archivo)
 * @param {string} ruc - RUC de la empresa
 * @returns {Object|null} Información del certificado o null si no existe
 */
function obtenerInfoCertificado(ruc) {
  const ruta = obtenerRutaCertificado(ruc);
  if (!fs.existsSync(ruta)) {
    return null;
  }
  
  const stats = fs.statSync(ruta);
  return {
    ruta: ruta,
    existe: true,
    tamano: stats.size,
    fechaCreacion: stats.birthtime,
    fechaModificacion: stats.mtime
  };
}

/**
 * Lista todos los certificados existentes
 * @returns {Array<string>} Array de RUCs con certificados
 */
function listarCertificados() {
  if (!fs.existsSync(CERTIFICADOS_BASE_PATH)) {
    return [];
  }
  
  const items = fs.readdirSync(CERTIFICADOS_BASE_PATH);
  return items.filter(item => {
    const ruta = path.join(CERTIFICADOS_BASE_PATH, item);
    return fs.statSync(ruta).isDirectory() && existeCertificado(item);
  });
}

module.exports = {
  crearCarpetaRuc,
  obtenerRutaCertificado,
  guardarCertificado,
  eliminarCertificado,
  cifrarContrasena,
  descifrarContrasena,
  existeCertificado,
  obtenerInfoCertificado,
  listarCertificados,
  CERTIFICADOS_BASE_PATH
};
