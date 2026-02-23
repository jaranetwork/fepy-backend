const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const Invoice = require('../models/Invoice');
const OperationLog = require('../models/OperationLog');
const { verificarToken } = require('../middleware/auth');

// Todas las rutas requieren autenticación
router.use(verificarToken);

// Obtener todas las facturas
router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 10, estado } = req.query;

    const query = {};
    if (estado) {
      query.estadoSifen = estado;
    }

    const invoices = await Invoice.find(query)
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    const total = await Invoice.countDocuments(query);

    res.json({
      invoices,
      totalPages: Math.ceil(total / limit),
      currentPage: parseInt(page),
      total
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Obtener una factura específica
router.get('/:id', async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);

    if (!invoice) {
      return res.status(404).json({ message: 'Factura no encontrada' });
    }

    res.json(invoice);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Obtener logs de una factura
router.get('/:id/logs', async (req, res) => {
  try {
    const logs = await OperationLog.find({ invoiceId: req.params.id })
      .sort({ createdAt: -1 });
    
    res.json(logs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Obtener todos los logs del sistema
router.get('/logs', async (req, res) => {
  try {
    const { page = 1, limit = 10, tipo, estado } = req.query;
    
    const query = {};
    if (tipo) {
      query.tipoOperacion = tipo;
    }
    if (estado) {
      query.estado = estado;
    }
    
    const logs = await OperationLog.find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit) * 1)
      .skip((parseInt(page) - 1) * parseInt(limit))
      .exec();
    
    const total = await OperationLog.countDocuments(query);
    
    res.json({
      logs,
      totalPages: Math.ceil(total / limit),
      currentPage: parseInt(page),
      total
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Reintentar envío de factura
router.post('/:id/retry', async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);

    if (!invoice) {
      return res.status(404).json({ message: 'Factura no encontrada' });
    }

    // Registrar intento de reenvío
    const retryLog = new OperationLog({
      invoiceId: invoice._id,
      tipoOperacion: 'reintento',
      descripcion: 'Reintento de envío a SIFEN',
      fecha: new Date()
    });

    await retryLog.save();

    // ========================================
    // LÓGICA DE REENVÍO:
    // 1. Leer el XML original desde el archivo
    // 2. Volver a enviar al mock-SET
    // 3. Actualizar el estado según la respuesta
    // ========================================
    
    // Verificar que existe el archivo XML
    if (!invoice.xmlPath || !fs.existsSync(path.join(__dirname, '../../de_output', invoice.xmlPath))) {
      return res.status(400).json({
        message: 'No se puede reenviar: XML no encontrado',
        detalle: 'El archivo XML de esta factura no existe en el servidor'
      });
    }

    // Leer el XML original
    const xmlPath = path.join(__dirname, '../../de_output', invoice.xmlPath);
    const xmlOriginal = fs.readFileSync(xmlPath, 'utf8');

    // Extraer el CDC de la factura
    const cdc = invoice.cdc;
    
    if (!cdc) {
      return res.status(400).json({
        message: 'No se puede reenviar: CDC no encontrado',
        detalle: 'La factura no tiene un CDC asociado'
      });
    }

    // Actualizar estado a procesando
    invoice.estadoSifen = 'procesando';
    await invoice.save();

    // Enviar el XML al mock-SET para actualizar el estado
    try {
      // Ruta corregida: subir 2 niveles desde routes/ hasta proyecto-sifen/
      const setApi = require('../../mock-set/setapi-mock').default;
      const idDocumento = 'retry-' + Date.now();
      const ambiente = process.env.AMBIENTE_SET || 'test';
      const certificateP12Path = path.join(__dirname, '../../../certificados', 'p12', 'certificado.p12');
      const certificatePassword = '123456';

      console.log(`🔄 Reenviando factura CDC ${cdc} al mock-SET...`);
      
      // Enviar el XML firmado (ya tiene el QR incrustado)
      const soapResponse = await setApi.recibe(idDocumento, xmlOriginal, ambiente, certificateP12Path, certificatePassword);

      console.log('📄 Respuesta SOAP recibida en reenvío:');
      console.log(soapResponse.substring(0, 500) + '...');

      // Extraer código de retorno de la respuesta
      const codigoRetorno = extraerCodigoRetorno(soapResponse);
      const mensajeRetorno = extraerMensajeRetorno(soapResponse);
      const estadoResultado = extraerEstadoResultado(soapResponse);

      // Determinar nuevo estado
      const nuevoEstado = determinarEstadoSegunCodigoRetorno(codigoRetorno, estadoResultado, mensajeRetorno);

      // Actualizar factura con la respuesta
      invoice.estadoSifen = nuevoEstado;
      invoice.codigoRetorno = codigoRetorno;
      invoice.mensajeRetorno = mensajeRetorno;
      await invoice.save();

      // Registrar resultado del reenvío
      const resultLog = new OperationLog({
        invoiceId: invoice._id,
        tipoOperacion: 'reintento_respuesta',
        descripcion: `Reenvío completado - Estado: ${nuevoEstado}, Código: ${codigoRetorno}`,
        estadoAnterior: 'procesando',
        estadoNuevo: nuevoEstado,
        fecha: new Date()
      });
      await resultLog.save();

      console.log(`✅ Reenvío completado - CDC: ${cdc}, Estado: ${nuevoEstado}`);

      res.json({
        message: 'Reenvío completado',
        invoice: invoice,
        estado: nuevoEstado,
        codigoRetorno: codigoRetorno,
        mensajeRetorno: mensajeRetorno
      });

    } catch (error) {
      console.error('❌ Error al reenviar:', error.message);
      
      invoice.estadoSifen = 'error';
      invoice.mensajeRetorno = `Error al reenviar: ${error.message}`;
      await invoice.save();
      
      res.status(500).json({
        message: 'Error al reenviar factura',
        error: error.message
      });
    }

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Descargar XML de una factura
router.get('/:id/download-xml', async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);

    if (!invoice) {
      return res.status(404).json({ message: 'Factura no encontrada' });
    }

    if (!invoice.xmlPath) {
      return res.status(404).json({ 
        message: 'XML no disponible',
        detalle: 'Esta factura no tiene un archivo XML asociado. Puede que haya sido creada antes de implementar el guardado de XMLs o que el envío a SET haya fallado.'
      });
    }

    // Construir la ruta completa al archivo XML
    const xmlPath = path.join(__dirname, '../../de_output', invoice.xmlPath);
    console.log(`📂 Buscando XML en: ${xmlPath}`);

    // Verificar que el archivo existe
    if (!fs.existsSync(xmlPath)) {
      console.error(`❌ Archivo no encontrado: ${xmlPath}`);
      return res.status(404).json({ 
        message: 'Archivo XML no encontrado en el servidor',
        ruta: xmlPath,
        correlativo: invoice.correlativo,
        detalle: 'El archivo XML no existe en el servidor. Puede que se haya eliminado manualmente o que haya un error en la ruta.'
      });
    }

    // Configurar headers para descarga
    const fileName = `factura_${invoice.correlativo}.xml`;
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    // Enviar el archivo
    const fileStream = fs.createReadStream(xmlPath);
    fileStream.pipe(res);
    
    fileStream.on('error', (error) => {
      console.error('Error en stream:', error);
      res.status(500).json({ message: 'Error al leer el archivo XML' });
    });
  } catch (error) {
    console.error('Error descargando XML:', error);
    res.status(500).json({ message: 'Error al descargar XML' });
  }
});

// Descargar PDF de una factura (KUDE)
router.get('/:id/download-pdf', async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);

    if (!invoice) {
      return res.status(404).json({ message: 'Factura no encontrada' });
    }

    if (!invoice.kudePath) {
      return res.status(404).json({
        message: 'PDF no disponible',
        detalle: 'Esta factura no tiene un archivo PDF KUDE asociado. Puede que el PDF no haya sido generado correctamente.'
      });
    }

    // Construir la ruta absoluta al archivo PDF
    // kudePath ya es una ruta absoluta desde server.js
    let pdfPath = invoice.kudePath;
    
    // Si kudePath es relativa, convertir a absoluta
    if (!path.isAbsolute(pdfPath)) {
      pdfPath = path.join(__dirname, '../../xml_output', pdfPath);
    }
    
    console.log(`📂 Buscando PDF en: ${pdfPath}`);

    // Verificar que el archivo existe
    if (!fs.existsSync(pdfPath)) {
      console.error(`❌ Archivo PDF no encontrado: ${pdfPath}`);
      return res.status(404).json({
        message: 'Archivo PDF no encontrado en el servidor',
        ruta: pdfPath,
        correlativo: invoice.correlativo,
        detalle: 'El archivo PDF no existe en el servidor. Puede que se haya eliminado manualmente o que haya un error en la ruta.'
      });
    }

    // Configurar headers para descarga
    const fileName = pdfPath.split('/').pop(); // Obtener el nombre del archivo desde la ruta
    res.setHeader('Content-Type', 'application/pdf');
    // RFC 5987: codificar caracteres especiales en filename
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);

    // Enviar el archivo
    const fileStream = fs.createReadStream(pdfPath);
    fileStream.pipe(res);

    fileStream.on('error', (error) => {
      console.error('Error en stream PDF:', error);
      res.status(500).json({ message: 'Error al leer el archivo PDF' });
    });
  } catch (error) {
    console.error('Error descargando PDF:', error);
    res.status(500).json({ message: 'Error al descargar PDF' });
  }
});

// ========================================
// FUNCIONES AUXILIARES PARA EXTRAER DATOS DE RESPUESTA SOAP
// ========================================

function extraerCodigoRetorno(xmlContent) {
  try {
    const match = xmlContent.match(/<codigoRetorno>(.*?)<\/codigoRetorno>/);
    if (match && match[1]) {
      return match[1].trim();
    }
    return null;
  } catch (error) {
    console.warn('⚠️ Error al extraer código de retorno:', error.message);
    return null;
  }
}

function extraerMensajeRetorno(xmlContent) {
  try {
    const match = xmlContent.match(/<mensajeRetorno>(.*?)<\/mensajeRetorno>/);
    if (match && match[1]) {
      return match[1].trim();
    }
    return null;
  } catch (error) {
    console.warn('⚠️ Error al extraer mensaje de retorno:', error.message);
    return null;
  }
}

function extraerEstadoResultado(xmlContent) {
  try {
    const match = xmlContent.match(/<estadoResultado>(.*?)<\/estadoResultado>/);
    if (match && match[1]) {
      return match[1].trim();
    }
    return null;
  } catch (error) {
    console.warn('⚠️ Error al extraer estado de resultado:', error.message);
    return null;
  }
}

function determinarEstadoSegunCodigoRetorno(codigoRetorno, estadoResultado = null, mensajeRetorno = null) {
  if (!codigoRetorno) return 'enviado';

  // Códigos de éxito
  if (codigoRetorno === '0000' || codigoRetorno === '0' || codigoRetorno === '2') {
    return 'aceptado';
  }
  
  // CDC encontrado en consulta
  if (codigoRetorno === '0421') {
    return 'aceptado';
  }
  
  // CDC pendiente
  if (codigoRetorno === '3' || codigoRetorno === '0003') {
    return 'procesando';
  }
  
  // CDC inexistente
  if (codigoRetorno === '0420') {
    return 'error';
  }
  
  // Rechazados
  if (['1000', '1001', '1002', '1003', '1004', '1'].includes(codigoRetorno)) {
    return 'rechazado';
  }
  
  return 'enviado';
}

module.exports = router;
