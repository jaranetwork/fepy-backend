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

// Importar wrapper de SET API (soporta Mock y Producción)
const setApi = require('../services/setapi-wrapper');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizarFechasEnObjeto, normalizarDatetime } = require('../utils/fechaUtils');
const {
  determinarEstadoSegunCodigo,
  determinarEstadoVisual,
  getColorPorEstadoVisual,
  extraerCodigoRetorno,
  extraerMensajeRetorno,
  extraerCDC,
  extraerDigestValue,
  extraerFechaProceso
} = require('../utils/estadoSifen');

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

    // ========================================
    // NORMALIZAR FECHAS DE ERPNext
    // ========================================
    // ERPNext envía fechas con microsegundos (ej: 2026-02-24T15:12:58.715809)
    // JavaScript espera milisegundos (ej: 2026-02-24T15:12:58.715Z)
    // Usamos datosFactura.data para la estructura unificada
    const data = datosFactura.data || datosFactura;
    console.log('📅 Normalizando fechas de ERPNext...');
    console.log('  Fecha original:', data.fecha);
    normalizarFechasEnObjeto(data);
    console.log('  Fecha normalizada:', data.fecha);

    // 1. Validar que se reciba el RUC
    // El RUC puede estar en param.ruc (estructura nueva) o en ruc (estructura vieja)
    const rucBusqueda = datosFactura.param?.ruc || ruc;
    
    if (!rucBusqueda) {
      return res.status(400).json({
        success: false,
        error: 'RUC de empresa requerido',
        mensaje: 'El campo "param.ruc" o "ruc" es requerido para identificar la empresa emisora'
      });
    }

    // 2. Buscar la empresa por RUC
    const empresa = await Empresa.findOne({ ruc: rucBusqueda });
    if (!empresa) {
      return res.status(404).json({
        success: false,
        error: `No se encontró una empresa con RUC ${rucBusqueda}`
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

    // 6. Generar hash para evitar duplicados (usando fecha normalizada)
    const facturaHash = generarFacturaHash({
      rucEmisor: ruc,
      numero: datosFactura.numero,
      fecha: datosFactura.fecha  // ← Ahora ya está normalizada
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
    // Obtener datos de la estructura unificada (param/data o plana)
    const datosData = datosFactura.data || datosFactura;
    const establecimiento = datosData.establecimiento || '001';
    const punto = datosData.punto || '001';
    const numero = datosData.numero || '0000001';
    const correlativo = `${establecimiento}-${punto}-${String(numero).padStart(7, '0')}`;

    const totalFactura = datosData.totalPago || datosData.total || datosFactura.totalPago ||
      (datosData.items?.reduce((sum, item) => sum + (item.precioTotal || 0), 0) || 0);

    // Obtener datos del cliente (soportar ambas estructuras)
    const cliente = datosData.cliente || datosFactura.cliente || {};

    const invoice = new Invoice({
      empresaId: empresa._id,
      rucEmpresa: ruc,
      correlativo: correlativo,
      cliente: {
        ruc: cliente.ruc || cliente.documentoNumero || 'N/A',
        nombre: cliente.razonSocial || cliente.nombreFantasia || cliente.nombre || 'N/A',
        razonSocial: cliente.razonSocial,
        nombreFantasia: cliente.nombreFantasia,
        direccion: cliente.direccion,
        telefono: cliente.telefono,
        email: cliente.email,
        documentoTipo: cliente.documentoTipo,
        documentoNumero: cliente.documentoNumero
      },
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

    // EXTRAER DigestValue del XML firmado ANTES de enviar (para validar después)
    let digestValueOriginal = null;
    try {
      const xml2js = require('xml2js');
      const xmlFirmadoObj = await xml2js.parseStringPromise(xmlFirmado);

      // La estructura es: rDE > Signature > SignedInfo > Reference > DigestValue
      if (xmlFirmadoObj?.rDE?.Signature?.[0]?.SignedInfo?.[0]?.Reference?.[0]?.DigestValue?.[0]) {
        digestValueOriginal = xmlFirmadoObj.rDE.Signature[0].SignedInfo[0].Reference[0].DigestValue[0];
        console.log(`🔐 DigestValue original del XML firmado: ${digestValueOriginal.substring(0, 30)}...`);
      } else {
        console.warn('⚠️ No se pudo extraer DigestValue del XML firmado');
      }
    } catch (err) {
      console.warn('⚠️ No se pudo extraer DigestValue del XML firmado');
    }

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
    const digestValueRespuesta = extraerDigestValue(respuestaSET);
    const fechaProceso = extraerFechaProceso(respuestaSET);

    console.log(`📄 Respuesta SET - Código: ${codigoRetorno}, Mensaje: ${mensajeRetorno}`);
    console.log(`   CDC: ${cdc}`);
    console.log(`   DigestValue respuesta: ${digestValueRespuesta ? digestValueRespuesta.substring(0, 30) + '...' : 'N/A'}`);
    console.log(`   Fecha Proceso: ${fechaProceso || 'N/A'}`);

    // VALIDAR DigestValue: El de la respuesta debe coincidir con el del XML firmado
    let digestValueValido = true;
    if (digestValueOriginal && digestValueRespuesta) {
      if (digestValueOriginal !== digestValueRespuesta) {
        console.error('❌ ERROR: DigestValue no coincide!');
        console.error(`   Original:   ${digestValueOriginal}`);
        console.error(`   Respuesta:  ${digestValueRespuesta}`);
        digestValueValido = false;
      } else {
        console.log('✅ DigestValue coincide correctamente');
      }
    }

    // 14. Actualizar factura en BD
    // Si el DigestValue no coincide, marcar como error independientemente del código de retorno
    let estadoSifen;
    let estadoVisual;
    
    if (!digestValueValido) {
      // Error de integridad: DigestValue no coincide
      estadoSifen = 'error';
      estadoVisual = 'rechazado';
      console.error('❌ Factura marcada como ERROR: DigestValue no coincide');
    } else {
      // DigestValue válido: usar estado según código de retorno
      estadoSifen = determinarEstadoSegunCodigo(codigoRetorno);
      estadoVisual = determinarEstadoVisual(codigoRetorno);
    }

    invoice.estadoSifen = estadoSifen;
    invoice.estadoVisual = estadoVisual;
    invoice.codigoRetorno = codigoRetorno;
    invoice.mensajeRetorno = mensajeRetorno;
    invoice.cdc = cdc;
    // Respetar fechaEnvio del JSON si existe, sino usar fecha actual
    const data = datosFactura.data || datosFactura;
    if (data.factura?.fechaEnvio) {
      invoice.fechaEnvio = new Date(data.factura.fechaEnvio);
    } else {
      invoice.fechaEnvio = new Date();
    }

    // Guardar respuesta completa SIFEN v150 con validación de DigestValue
    invoice.respuestaSifen = {
      codigo: codigoRetorno,
      estado: mensajeRetorno.includes('aprobado') || mensajeRetorno.includes('Autorización') ? 'Aprobado' : 'Rechazado',
      mensaje: mensajeRetorno,
      fechaProceso: fechaProceso || new Date().toISOString().replace('T', ' ').substring(0, 19),
      digestValue: digestValueRespuesta || null,
      digestValueOriginal: digestValueOriginal || null,
      digestValueValido: digestValueValido
    };

    console.log(`  Estado SIFEN: ${estadoSifen}, Estado Visual: ${estadoVisual}`);
    
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
    fs.writeFileSync(rutaArchivo, xmlConQR, 'utf8');

    invoice.xmlPath = `${anio}/${mes}/${nombreArchivo}`;

    await invoice.save();

    // 16. Registrar resultado - Verificar estado visual de la factura
    let tipoOperacion = 'respuesta_sifen';
    let descripcion = `Respuesta SET recibida - CDC: ${cdc}`;
    let logEstado = 'success';

    if (invoice.estadoVisual === 'aceptado') {
      tipoOperacion = 'envio_exitoso';
      descripcion = `Factura aceptada por SET - CDC: ${cdc}, Código: ${codigoRetorno}`;
      logEstado = 'success';
    } else if (invoice.estadoVisual === 'observado') {
      tipoOperacion = 'actualizacion_estado';
      descripcion = `Factura observada - CDC: ${cdc}, Código: ${codigoRetorno}, Mensaje: ${mensajeRetorno}`;
      logEstado = 'warning';
    } else if (invoice.estadoVisual === 'rechazado') {
      tipoOperacion = 'error';
      descripcion = `Factura rechazada por SET - CDC: ${cdc}, Código: ${codigoRetorno}, Mensaje: ${mensajeRetorno}`;
      logEstado = 'error';
    }

    await OperationLog.create({
      invoiceId: invoice._id,
      tipoOperacion: tipoOperacion,
      descripcion: descripcion,
      estado: logEstado,
      estadoAnterior: 'procesando',
      estadoNuevo: invoice.estadoSifen,
      detalle: {
        codigoRetorno: codigoRetorno,
        mensajeRetorno: mensajeRetorno,
        estadoVisual: invoice.estadoVisual,
        respuestaSifen: invoice.respuestaSifen
      }
    });

    if (invoice.estadoVisual === 'aceptado') {
      console.log(`✅ Factura procesada exitosamente - CDC: ${cdc}, Código: ${codigoRetorno}`);
    } else if (invoice.estadoVisual === 'observado') {
      console.log(`⚠️ Factura observada - CDC: ${cdc}, Código: ${codigoRetorno}, Mensaje: ${mensajeRetorno}`);
    } else if (invoice.estadoVisual === 'rechazado') {
      console.log(`❌ Factura rechazada por SET - CDC: ${cdc}, Código: ${codigoRetorno}`);
    } else {
      console.log(`📋 Factura ${invoice.estadoSifen} - CDC: ${cdc}`);
    }
    
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
 * Soporta estructura plana y estructura param/data
 */
function generarFacturaHash(datos) {
  // Soportar ambas estructuras: param/data y plana
  const ruc = datos.param?.ruc || datos.ruc || datos.rucEmisor || '';
  const establecimiento = datos.data?.establecimiento || datos.establecimiento || '001';
  const numero = datos.data?.numero || datos.numero || '';

  // Hash único por RUC + Establecimiento + Número
  const cadena = `${ruc}|${establecimiento}|${numero}`;
  return crypto.createHash('sha256').update(cadena).digest('hex');
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
