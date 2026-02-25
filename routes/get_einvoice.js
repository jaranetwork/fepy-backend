/**
 * Ruta POST /get_einvoice
 * Encola factura para procesamiento asíncrono
 * Requiere autenticación con API Key o JWT
 */

const express = require('express');
const router = express.Router();
const Invoice = require('../models/Invoice');
const Empresa = require('../models/Empresa');
const { facturaQueue } = require('../queues/facturaQueue');
const { verificarToken } = require('../middleware/auth');
const { normalizarFechasEnObjeto, normalizarDatetime } = require('../utils/fechaUtils');

// Usar middleware de autenticación en todas las rutas de este archivo
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

router.post('/get_einvoice', async (req, res) => {
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
        error: 'Empresa no encontrada',
        mensaje: `No se encontró una empresa con RUC ${rucEmpresa}`
      });
    }

    if (!empresa.activo) {
      return res.status(400).json({
        error: 'Empresa inactiva',
        mensaje: `La empresa "${empresa.nombreFantasia}" está inactiva`
      });
    }

    if (!empresa.tieneCertificadoValido()) {
      return res.status(400).json({
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
    const correlativoCompleto = `${datosFactura.establecimiento || '001'}${datosFactura.punto || '001'}${String(datosFactura.numero || '0000001').padStart(7, '0')}`;

    const totalFactura = datosFactura.total || 
                         datosFactura.totalPago || 
                         (datosFactura.items?.reduce((sum, item) => sum + (item.precioTotal || item.precioUnitario * item.cantidad || 0), 0) || 0);

    const invoice = new Invoice({
      correlativo: correlativoCompleto,
      cliente: {
        ...datosFactura.cliente,
        nombre: datosFactura.cliente?.razonSocial || datosFactura.cliente?.nombre || 'N/A'
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
    console.error('❌ Error encolando factura:', error);

    res.status(500).json({
      error: 'Error al encolar la factura electrónica',
      mensaje: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

module.exports = router;
