/**
 * Rutas para gestión de empresas
 * Todas las rutas requieren autenticación
 */

const express = require('express');
const router = express.Router();
const { verificarToken } = require('../middleware/auth');
const { upload, manejarErrorUpload } = require('../middleware/upload');
const empresaController = require('../controllers/empresaController');

// Todas las rutas requieren autenticación
router.use(verificarToken);

/**
 * @route   GET /api/empresas
 * @desc    Listar todas las empresas del usuario
 * @access  Privada (requiere JWT o API Key)
 */
router.get('/', empresaController.listar);

/**
 * @route   POST /api/empresas
 * @desc    Crear una nueva empresa
 * @access  Privada (requiere JWT o API Key)
 */
router.post('/', empresaController.crear);

/**
 * @route   GET /api/empresas/:id
 * @desc    Obtener detalles de una empresa
 * @access  Privada (requiere JWT o API Key)
 */
router.get('/:id', empresaController.obtener);

/**
 * @route   PUT /api/empresas/:id
 * @desc    Actualizar empresa existente
 * @access  Privada (requiere JWT o API Key)
 */
router.put('/:id', empresaController.actualizar);

/**
 * @route   DELETE /api/empresas/:id
 * @desc    Eliminar empresa
 * @access  Privada (requiere JWT o API Key)
 */
router.delete('/:id', empresaController.eliminar);

/**
 * @route   POST /api/empresas/:id/certificado
 * @desc    Subir/actualizar certificado digital
 * @access  Privada (requiere JWT o API Key)
 */
router.post(
  '/:id/certificado',
  upload.single('certificado'),
  manejarErrorUpload,
  empresaController.subirCertificado
);

/**
 * @route   GET /api/empresas/:id/validar-certificado
 * @desc    Validar certificado de una empresa
 * @access  Privada (requiere JWT o API Key)
 */
router.get('/:id/validar-certificado', empresaController.validarCertificado);

/**
 * @route   GET /api/empresas/:id/stats
 * @desc    Obtener estadísticas de una empresa
 * @access  Privada (requiere JWT o API Key)
 */
router.get('/:id/stats', empresaController.obtenerStats);

module.exports = router;
