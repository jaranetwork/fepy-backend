/**
 * Rutas para generación de facturas electrónicas
 * API consistente para creación y consulta de facturas
 */

const express = require('express');
const router = express.Router();
const Invoice = require('../models/Invoice');
const Empresa = require('../models/Empresa');
const { facturaQueue } = require('../queues/facturaQueue');
const { verificarToken } = require('../middleware/auth');
const { normalizarFechasEnObjeto, normalizarDatetime } = require('../utils/fechaUtils');

// Todas las rutas requieren autenticación
router.use(verificarToken);

// Generar hash para detectar duplicados
function generarFacturaHash(datosFactura) {
  const crypto = require('crypto');
  const ruc = datosFactura.ruc?.replace(/[^0-9]/g, '') || '';
  const numero = datosFactura.numero || '';
  // Normalizar fecha para evitar errores con microsegundos de ERPNext
  const fecha = normalizarDatetime(datosFactura.fecha);
  const cadena = `${ruc}|${numero}|${fecha}`;
  return crypto.createHash('sha256').update(cadena).digest('hex');
}

/**
 * @route   POST /api/facturar/crear
 * @desc    Crear factura electrónica y encolar para procesamiento
 * @access  Privada (requiere API Key o JWT)
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
router.post('/crear', async (req, res) => {
  try {
    let datosFactura = req.body;

    // ========================================
    // NORMALIZAR FECHAS DE ERPNext
    // ========================================
    // ERPNext envía fechas con microsegundos (ej: 2026-02-24T15:12:58.715809)
    // JavaScript espera milisegundos (ej: 2026-02-24T15:12:58.715Z)
    console.log('📅 Normalizando fechas de ERPNext...');
    console.log('  Fecha original:', datosFactura.fecha);
    datosFactura = normalizarFechasEnObjeto(datosFactura);
    console.log('  Fecha normalizada:', datosFactura.fecha);

    // ========================================
    // BUSCAR EMPRESA POR RUC
    // ========================================
    const rucEmpresa = datosFactura.ruc?.trim();

    if (!rucEmpresa) {
      return res.status(400).json({
        success: false,
        error: 'RUC de empresa requerido',
        mensaje: 'El campo "ruc" es requerido para identificar la empresa emisora'
      });
    }

    // Buscar empresa en BD
    let empresa = await Empresa.findOne({ ruc: rucEmpresa });

    // Búsquedas alternativas con/sin guión
    if (!empresa && rucEmpresa.includes('-')) {
      const rucSinGuiones = rucEmpresa.replace(/[^0-9]/g, '');
      empresa = await Empresa.findOne({ ruc: rucSinGuiones });
    }
    if (!empresa && !rucEmpresa.includes('-')) {
      const rucSinGuiones = rucEmpresa.replace(/[^0-9]/g, '');
      if (rucSinGuiones.length >= 7 && rucSinGuiones.length <= 9) {
        const parteNumerica = rucSinGuiones.slice(0, -1);
        const dv = rucSinGuiones.slice(-1);
        const rucConGuion = `${parteNumerica}-${dv}`;
        empresa = await Empresa.findOne({ ruc: rucConGuion });
      }
    }

    if (!empresa) {
      return res.status(404).json({
        success: false,
        error: 'Empresa no encontrada',
        mensaje: `No se encontró una empresa con RUC ${rucEmpresa}`
      });
    }

    if (!empresa.activo) {
      return res.status(400).json({
        success: false,
        error: 'Empresa inactiva',
        mensaje: `La empresa "${empresa.nombreFantasia}" está inactiva`
      });
    }

    if (!empresa.tieneCertificadoValido()) {
      return res.status(400).json({
        success: false,
        error: 'Certificado inválido',
        mensaje: 'La empresa no tiene un certificado digital válido cargado'
      });
    }

    console.log(`✅ Empresa encontrada: ${empresa.nombreFantasia} (RUC: ${empresa.ruc})`);

    // ========================================
    // VERIFICAR DUPLICADOS
    // ========================================
    const facturaHash = generarFacturaHash(datosFactura);
    const facturaExistente = await Invoice.findOne({ facturaHash });

    if (facturaExistente) {
      return res.status(409).json({
        success: false,
        error: 'Factura duplicada',
        mensaje: 'La factura con estos datos ya ha sido registrada previamente',
        facturaId: facturaExistente._id,
        detalles: {
          fechaCreacion: facturaExistente.fechaCreacion,
          correlativo: facturaExistente.correlativo,
          estadoSifen: facturaExistente.estadoSifen,
          cdc: facturaExistente.cdc
        }
      });
    }

    // ========================================
    // CREAR REGISTRO EN BD (ESTADO: ENCOLADO)
    // ========================================
    // Formato SIFEN: 001-001-0000003 (establecimiento-punto-numero)
    const correlativoCompleto = `${String(datosFactura.establecimiento || '001').padStart(3, '0')}-${String(datosFactura.punto || '001').padStart(3, '0')}-${String(datosFactura.numero || '0000001').padStart(7, '0')}`;

    const totalFactura = datosFactura.total ||
                         datosFactura.totalPago ||
                         (datosFactura.items?.reduce((sum, item) => sum + (item.precioTotal || item.precioUnitario * item.cantidad || 0), 0) || 0);

    const invoice = new Invoice({
      correlativo: correlativoCompleto,
      cliente: {
        ruc: datosFactura.cliente?.ruc || datosFactura.cliente?.documentoNumero || 'N/A',
        nombre: datosFactura.cliente?.razonSocial || datosFactura.cliente?.nombreFantasia || datosFactura.cliente?.nombre || 'N/A',
        razonSocial: datosFactura.cliente?.razonSocial,
        nombreFantasia: datosFactura.cliente?.nombreFantasia,
        direccion: datosFactura.cliente?.direccion,
        telefono: datosFactura.cliente?.telefono,
        email: datosFactura.cliente?.email,
        documentoTipo: datosFactura.cliente?.documentoTipo,
        documentoNumero: datosFactura.cliente?.documentoNumero
      },
      total: totalFactura,
      fechaCreacion: new Date(),
      estadoSifen: 'encolado',
      datosFactura: datosFactura,
      facturaHash: facturaHash
    });

    await invoice.save();
    console.log(`📦 Factura creada en BD: ${invoice._id} (estado: encolado)`);

    // ========================================
    // ENCOLAR TRABAJO PARA PROCESAMIENTO ASÍNCRONO
    // ========================================
    const job = await facturaQueue.add('generar-factura', {
      facturaId: invoice._id.toString(),
      datosFactura: datosFactura,
      empresaId: empresa._id.toString()
    }, {
      priority: 0,
      jobId: `factura-${invoice._id}`,
      timeout: 300000  // 5 minutos
    });

    console.log(`📋 Job ${job.id} encolado para procesamiento`);

    // ========================================
    // RESPONDER INMEDIATAMENTE (NO BLOQUEANTE)
    // ========================================
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    
    res.status(202).json({
      success: true,
      message: 'Factura encolada para procesamiento asíncrono',
      data: {
        facturaId: invoice._id,
        correlativo: correlativoCompleto,
        estado: 'encolado',
        jobId: job.id,
        // Campos que se completarán después del procesamiento
        cdc: null,  // Se genera cuando SET aprueba la factura
        // URLs de descarga (disponibles cuando se generen los archivos)
        xmlLink: `${baseUrl}/api/invoices/${invoice._id}/download-xml`,
        kudeLink: `${baseUrl}/api/invoices/${invoice._id}/download-pdf`,
        urls: {
          estado: `/api/factura/estado/${invoice._id}`,
          consulta: `/api/invoices/${invoice._id}`
        }
      }
    });

  } catch (error) {
    console.error('❌ Error creando factura:', error);

    res.status(500).json({
      success: false,
      error: 'Error al crear factura electrónica',
      mensaje: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

/**
 * @route   GET /api/facturar/empresa/:ruc
 * @desc    Obtener información de empresa por RUC (para verificar antes de enviar)
 * @access  Privada (requiere API Key o JWT)
 */
router.get('/empresa/:ruc', async (req, res) => {
  try {
    const ruc = req.params.ruc?.trim();

    if (!ruc) {
      return res.status(400).json({
        success: false,
        error: 'RUC requerido'
      });
    }

    const empresa = await Empresa.findOne({ ruc });

    if (!empresa) {
      return res.status(404).json({
        success: false,
        error: 'Empresa no encontrada',
        mensaje: `No se encontró una empresa con RUC ${ruc}`
      });
    }

    res.json({
      success: true,
      data: {
        ruc: empresa.ruc,
        nombreFantasia: empresa.nombreFantasia,
        razonSocial: empresa.razonSocial,
        tieneCertificadoValido: empresa.tieneCertificadoValido(),
        activo: empresa.activo
      }
    });

  } catch (error) {
    console.error('❌ Error obteniendo empresa:', error);
    res.status(500).json({
      success: false,
      error: 'Error al obtener empresa',
      mensaje: error.message
    });
  }
});

module.exports = router;
