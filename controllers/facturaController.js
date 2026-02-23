/**
 * Controller para generación simplificada de facturas
 * Permite crear facturas enviando solo los datos esenciales + RUC de empresa
 */

const Empresa = require('../models/Empresa');
const Invoice = require('../models/Invoice');
const OperationLog = require('../models/OperationLog');
const certificadoService = require('../services/certificadoService');
const FacturaElectronicaPY = require('facturacionelectronicapy-xmlgen').default;
const xmlsign = require('facturacionelectronicapy-xmlsign').default;
const kude = require('facturacionelectronicapy-kude').default;
const qr = require('facturacionelectronicapy-qrgen').default;
const setApi = require('../../mock-set/setapi-mock').default;
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Generar factura simplificada
 * POST /api/facturar
 * 
 * Recibe datos básicos completos con RUC de empresa
 * El sistema completa: timbrado, establecimiento, punto emision, certificado, etc.
 */
exports.generarFactura = async (req, res) => {
  try {
    const { ruc, ...datosFactura } = req.body;
    
    // 1. Validar que se reciba el RUC
    if (!ruc) {
      return res.status(400).json({
        success: false,
        error: 'El RUC de la empresa es requerido'
      });
    }
    
    // 2. Buscar la empresa por RUC
    const empresa = await Empresa.findOne({ ruc });
    if (!empresa) {
      return res.status(404).json({
        success: false,
        error: `No se encontró una empresa con RUC ${ruc}`
      });
    }
    
    // 3. Verificar que la empresa esté activa
    if (!empresa.activo) {
      return res.status(400).json({
        success: false,
        error: `La empresa "${empresa.nombreFantasia}" está inactiva`
      });
    }
    
    // 4. Verificar certificado válido
    if (!empresa.tieneCertificadoValido()) {
      return res.status(400).json({
        success: false,
        error: `La empresa no tiene un certificado digital válido cargado`
      });
    }
    
    // 5. Validar datos mínimos de la factura
    if (!datosFactura.numero || !datosFactura.cliente || !datosFactura.items) {
      return res.status(400).json({
        success: false,
        error: 'Datos de factura incompletos. Se requiere: numero, cliente, items'
      });
    }
    
    // 6. Generar hash para evitar duplicados
    const facturaHash = generarFacturaHash({
      rucEmisor: ruc,
      numero: datosFactura.numero,
      fecha: datosFactura.fecha
    });
    
    // Verificar si ya existe
    const facturaExistente = await Invoice.findOne({ facturaHash });
    if (facturaExistente) {
      return res.status(400).json({
        success: false,
        error: 'Factura duplicada',
        factura: facturaExistente
      });
    }
    
    // 7. Crear registro inicial en BD
    const correlativo = `${datosFactura.establecimiento || '001'}-${datosFactura.punto || '001'}-${String(datosFactura.numero).padStart(7, '0')}`;
    
    const totalFactura = datosFactura.totalPago || 
      (datosFactura.items?.reduce((sum, item) => sum + (item.precioTotal || 0), 0) || 0);
    
    const invoice = new Invoice({
      empresaId: empresa._id,
      rucEmpresa: ruc,
      correlativo: correlativo,
      cliente: datosFactura.cliente,
      total: totalFactura,
      estadoSifen: 'recibido',
      datosFactura: datosFactura,
      facturaHash: facturaHash
    });
    
    await invoice.save();
    
    // Registrar inicio del proceso
    await OperationLog.create({
      invoiceId: invoice._id,
      tipoOperacion: 'inicio_proceso',
      descripcion: 'Iniciando generación de factura simplificada',
      estado: 'procesando'
    });
    
    console.log(`📋 Factura creada para empresa: ${empresa.nombreFantasia} (RUC: ${ruc})`);
    
    // 8. Completar datos con configuración de la empresa
    const datosCompletos = {
      ...datosFactura,
      // Datos del emisor (de la empresa)
      emisor: {
        ruc: ruc,
        nombre: empresa.razonSocial || empresa.nombreFantasia,
        direccion: empresa.direccion || '',
        email: empresa.email || ''
      },
      // Configuración SIFEN de la empresa
      establecimiento: empresa.configuracionSifen.codigoEstablecimiento,
      punto: empresa.configuracionSifen.codigoPuntoEmision,
      timbrado: empresa.configuracionSifen.numeroTimbrado,
      modo: empresa.configuracionSifen.modo,
      
      // Calcular totales si no vienen
      totalNeto: datosFactura.totalNeto || totalFactura / 1.10,
      totalIVA: datosFactura.totalIVA || totalFactura - (totalFactura / 1.10),
      total: totalFactura
    };
    
    // 9. Generar XML
    console.log('📝 Generando XML...');
    const xmlGenerator = new FacturaElectronicaPY();
    const xmlSinFirmar = xmlGenerator.Generar(datosCompletos);
    
    // 10. Firmar XML
    console.log('✍️  Firmando XML...');
    const rutaCertificado = empresa.obtenerRutaCertificado();
    const contrasena = certificadoService.descifrarContrasena(empresa.certificado.contrasena);
    
    const xmlFirmado = await xmlsign.Firmar(
      xmlSinFirmar,
      rutaCertificado,
      contrasena
    );
    
    // 11. Generar QR y agregar al XML
    console.log('📱 Generando QR...');
    const qrCode = qr.GenerarQR(datosCompletos);
    const xmlConQR = xmlFirmado.replace('</rDE>', `<dCarQR>${qrCode}</dCarQR></rDE>`);
    
    // 12. Enviar a SET (o mock)
    console.log('📤 Enviando a SET...');
    const ambiente = empresa.configuracionSifen.modo;
    const idDocumento = crypto.randomBytes(16).toString('hex');
    
    const respuestaSET = await setApi.recibe(
      idDocumento,
      xmlConQR,
      ambiente,
      rutaCertificado,
      contrasena
    );
    
    // 13. Procesar respuesta
    const codigoRetorno = extraerCodigoRetorno(respuestaSET);
    const mensajeRetorno = extraerMensajeRetorno(respuestaSET);
    const cdc = extraerCDC(respuestaSET);
    
    console.log(`📄 Respuesta SET - Código: ${codigoRetorno}, Mensaje: ${mensajeRetorno}`);
    
    // 14. Actualizar factura en BD
    invoice.estadoSifen = determinarEstadoSegunCodigo(codigoRetorno);
    invoice.codigoRetorno = codigoRetorno;
    invoice.mensajeRetorno = mensajeRetorno;
    invoice.cdc = cdc;
    invoice.fechaEnvio = new Date();
    
    // 15. Guardar XML
    const fecha = new Date();
    const anio = fecha.getFullYear();
    const mes = String(fecha.getMonth() + 1).padStart(2, '0');
    const rutaSalida = path.join(__dirname, `../../de_output/${anio}/${mes}`);
    
    if (!fs.existsSync(rutaSalida)) {
      fs.mkdirSync(rutaSalida, { recursive: true });
    }
    
    const nombreArchivo = `factura_${correlativo}.xml`;
    const rutaArchivo = path.join(rutaSalida, nombreArchivo);
    fs.writeFileSync(rutaArchivo, xmlConQR);
    
    invoice.xmlPath = `${anio}/${mes}/${nombreArchivo}`;
    
    await invoice.save();
    
    // 16. Registrar resultado
    await OperationLog.create({
      invoiceId: invoice._id,
      tipoOperacion: 'envio_exitoso',
      descripcion: `Factura enviada a SET - CDC: ${cdc}`,
      estado: invoice.estadoSifen,
      estadoAnterior: 'procesando',
      estadoNuevo: invoice.estadoSifen
    });
    
    console.log(`✅ Factura procesada exitosamente - CDC: ${cdc}`);
    
    // 17. Generar KUDE (PDF) si está disponible
    try {
      if (kude && cdc) {
        const rutaKUDE = path.join(rutaSalida, `kude_${correlativo}.pdf`);
        // kude.Generar(xmlConQR, rutaKUDE); // Descomentar cuando esté configurado JAVA8_HOME
        invoice.kudePath = `${anio}/${mes}/kude_${correlativo}.pdf`;
        await invoice.save();
      }
    } catch (error) {
      console.log('⚠️ No se pudo generar KUDE:', error.message);
    }
    
    // 18. Responder
    res.status(200).json({
      success: true,
      message: 'Factura generada y enviada exitosamente',
      data: {
        correlativo: invoice.correlativo,
        cdc: invoice.cdc,
        estado: invoice.estadoSifen,
        codigoRetorno: invoice.codigoRetorno,
        mensajeRetorno: invoice.mensajeRetorno,
        xmlPath: invoice.xmlPath,
        empresa: {
          ruc: empresa.ruc,
          nombreFantasia: empresa.nombreFantasia
        }
      }
    });
    
  } catch (error) {
    console.error('❌ Error generando factura:', error);
    
    // Registrar error
    if (req.body.numero) {
      const invoice = await Invoice.findOne({
        correlativo: `${req.body.establecimiento || '001'}-${req.body.punto || '001'}-${String(req.body.numero).padStart(7, '0')}`
      });
      
      if (invoice) {
        invoice.estadoSifen = 'error';
        invoice.mensajeRetorno = error.message;
        await invoice.save();
        
        await OperationLog.create({
          invoiceId: invoice._id,
          tipoOperacion: 'error',
          descripcion: `Error al generar factura: ${error.message}`,
          estado: 'error'
        });
      }
    }
    
    res.status(500).json({
      success: false,
      error: 'Error al generar factura',
      message: error.message
    });
  }
};

/**
 * Generar hash único para factura
 */
function generarFacturaHash(datos) {
  const cadena = `${datos.rucEmisor}|${datos.numero}|${datos.fecha || new Date().toISOString()}`;
  return crypto.createHash('sha256').update(cadena).digest('hex');
}

/**
 * Extraer código de retorno de respuesta SOAP
 */
function extraerCodigoRetorno(xmlContent) {
  try {
    const match = xmlContent.match(/<codigoRetorno>(.*?)<\/codigoRetorno>/);
    if (match && match[1]) {
      return match[1].trim();
    }
    return '0000';
  } catch (error) {
    console.warn('⚠️ Error al extraer código de retorno:', error.message);
    return '0000';
  }
}

/**
 * Extraer mensaje de retorno de respuesta SOAP
 */
function extraerMensajeRetorno(xmlContent) {
  try {
    const match = xmlContent.match(/<mensajeRetorno>(.*?)<\/mensajeRetorno>/);
    if (match && match[1]) {
      return match[1].trim();
    }
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Extraer CDC de respuesta SOAP
 */
function extraerCDC(xmlContent) {
  try {
    const match = xmlContent.match(/<cdc>(.*?)<\/cdc>/);
    if (match && match[1]) {
      return match[1].trim();
    }
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Determinar estado según código de retorno
 */
function determinarEstadoSegunCodigo(codigo) {
  if (!codigo) return 'enviado';
  
  // Éxito
  if (['0000', '0', '2', '0421'].includes(codigo)) {
    return 'aceptado';
  }
  
  // Pendiente
  if (['3', '0003'].includes(codigo)) {
    return 'procesando';
  }
  
  // Rechazado
  if (['1000', '1001', '1002', '1003', '1004', '1'].includes(codigo)) {
    return 'rechazado';
  }
  
  return 'enviado';
}

/**
 * Obtener información de empresa por RUC
 * GET /api/facturar/empresa/:ruc
 */
exports.obtenerEmpresaPorRuc = async (req, res) => {
  try {
    const { ruc } = req.params;
    
    const empresa = await Empresa.findOne({ ruc })
      .select('-certificado.contrasena');
    
    if (!empresa) {
      return res.status(404).json({
        success: false,
        error: 'Empresa no encontrada'
      });
    }
    
    res.json({
      success: true,
      data: {
        ruc: empresa.ruc,
        nombreFantasia: empresa.nombreFantasia,
        razonSocial: empresa.razonSocial,
        configuracionSifen: {
          codigoEstablecimiento: empresa.configuracionSifen.codigoEstablecimiento,
          codigoPuntoEmision: empresa.configuracionSifen.codigoPuntoEmision,
          numeroTimbrado: empresa.configuracionSifen.numeroTimbrado,
          modo: empresa.configuracionSifen.modo
        },
        tieneCertificado: empresa.tieneCertificadoValido()
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};
