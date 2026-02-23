/**
 * Rutas para generación simplificada de facturas
 * Permite crear facturas enviando solo datos esenciales + RUC de empresa
 */

const express = require('express');
const router = express.Router();
const { verificarToken } = require('../middleware/auth');
const facturaController = require('../controllers/facturaController');

/**
 * @route   POST /api/facturar
 * @desc    Generar factura simplificada (completa datos con config de empresa)
 * @access  Pública (o proteger con verificarToken si se requiere auth)
 * 
 * Body:
 * {
 *   "ruc": "80012345",              // RUC de la empresa (requerido)
 *   "numero": "0000060",            // Número de factura
 *   "cliente": { ... },             // Datos del cliente
 *   "items": [ ... ],               // Items de la factura
 *   ...                            // Resto de datos opcionales
 * }
 */
router.post('/', facturaController.generarFactura);

/**
 * @route   GET /api/facturar/empresa/:ruc
 * @desc    Obtener información de empresa por RUC (para verificar antes de enviar)
 * @access  Pública
 */
router.get('/empresa/:ruc', facturaController.obtenerEmpresaPorRuc);

module.exports = router;
