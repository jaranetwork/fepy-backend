/**
 * Servicio de Procesamiento de Facturas
 * Contiene la lógica principal para generar, firmar y enviar facturas
 * Es llamado desde el worker de manera asíncrona
 */

const Invoice = require('../models/Invoice');
const Empresa = require('../models/Empresa');
const certificadoService = require('./certificadoService');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { formatoFechaSIFEN, convertirFechasASIFEN } = require('../utils/fechaUtils');
const {
  extraerCodigoRetorno,
  extraerMensajeRetorno,
  extraerEstadoResultado,
  extraerFechaProceso,
  extraerDigestValue,
  determinarEstadoSegunCodigo,
  determinarEstadoVisual
} = require('../utils/estadoSifen');

// Librerías SIFEN
const FacturaElectronicaPY = require('facturacionelectronicapy-xmlgen').default;
const xmlsign = require('facturacionelectronicapy-xmlsign').default;
const qr = require('facturacionelectronicapy-qrgen').default;
const kude = require('facturacionelectronicapy-kude').default;

// Importar wrapper de SET API (soporta Mock y Producción)
const setApi = require('./setapi-wrapper');

/**
 * Procesa una factura electrónica completa
 * @param {Object} datosFactura - Datos de la factura
 * @param {String} empresaId - ID de la empresa
 * @param {Object} job - Job de Bull (para reportar progreso)
 * @param {String} invoiceId - ID de la factura en BD (para actualizar con DigestValue)
 * @returns {Object} Resultado del procesamiento
 */
async function procesarFactura(datosFactura, empresaId, job = null, invoiceId = null) {
  const reportarProgreso = async (progress) => {
    if (job && job.progress) {
      await job.progress(progress);
    }
  };

  // Variables para almacenar CDC y DigestValue (extraídos después de firmar)
  let digestValueFirma = null;
  let cdcFirma = null;

  try {
    // ========================================
    // 1. Buscar empresa y validar
    // ========================================
    await reportarProgreso(5);
    
    const Empresa = require('../models/Empresa');
    const empresa = await Empresa.findById(empresaId);
    if (!empresa) {
      throw new Error('Empresa no encontrada');
    }

    if (!empresa.activo) {
      throw new Error(`Empresa "${empresa.nombreFantasia}" está inactiva`);
    }

    if (!empresa.tieneCertificadoValido()) {
      throw new Error('La empresa no tiene un certificado digital válido');
    }

    console.log(`🏢 Procesando factura para: ${empresa.nombreFantasia} (RUC: ${empresa.ruc})`);
    await reportarProgreso(10);

    // ========================================
    // 2. Completar datos con configuración de empresa
    // ========================================
    const data = datosFactura.data || datosFactura;
    const datosCompletos = completarDatosConEmpresa(data, empresa);
    await reportarProgreso(15);

    // ========================================
    // 3. Generar params para xmlgen (usando estructura unificada param/data)
    // ========================================
    // NOTA: El CDC se genera automáticamente dentro de generateXMLDE()
    const param = datosFactura.param || {};
    const timbrado = param.timbradoNumero || datosCompletos.timbrado || empresa.configuracionSifen.timbrado || '12558946';
    const establecimiento = datosCompletos.establecimiento || '001';

    // Calcular fecha de timbrado (usar la del param o la de la factura)
    let timbradoFecha = "2022-08-25";  // Por defecto
    if (param.timbradoFecha) {
      timbradoFecha = param.timbradoFecha;
    } else if (data.fecha) {
      // Extraer solo la fecha (YYYY-MM-DD) sin hora ni microsegundos
      timbradoFecha = data.fecha.split('T')[0];
    }

    const params = {
      version: param.version || 150,
      ruc: param.ruc || empresa.ruc,
      razonSocial: param.razonSocial || empresa.razonSocial || param.nombreFantasia || 'Empresa S.A.',
      nombreFantasia: param.nombreFantasia || empresa.nombreFantasia || 'Empresa',
      actividadesEconomicas: param.actividadesEconomicas || [{
        codigo: "1254",
        descripcion: "Desarrollo de Software"
      }],
      timbradoNumero: timbrado,
      timbradoFecha: timbradoFecha,
      tipoContribuyente: param.tipoContribuyente || 2,
      tipoRegimen: param.tipoRegimen || 8,
      establecimientos: param.establecimientos || [{
        codigo: establecimiento,
        denominacion: "MATRIZ",
        direccion: param.direccion || empresa.direccion || "N/A",
        numeroCasa: "0",
        departamento: 11,
        departamentoDescripcion: "ALTO PARANA",
        distrito: 145,
        distritoDescripcion: "CIUDAD DEL ESTE",
        ciudad: 3432,
        ciudadDescripcion: "PUERTO PTE.STROESSNER (MUNIC)",
        telefono: param.telefono || empresa.telefono || "0973-527155",
        email: param.email || empresa.email || "test@empresa.com.py"
      }]
    };

    await reportarProgreso(25);

    // ========================================
    // 4. Generar XML
    // ========================================
    console.log('📝 Generando XML...');

    // CRÍTICO: Convertir TODAS las fechas a formato SIFEN antes de pasar a xmlgen
    // La librería facturacionelectronicapy-xmlgen NO acepta fechas con 'Z' o milisegundos
    console.log('📅 Convirtiendo fechas a formato SIFEN para xmlgen...');
    console.log('   fecha antes:', datosCompletos.fecha);
    convertirFechasASIFEN(datosCompletos);  // ← Modifica el objeto en su lugar (sin reasignar)
    console.log('   fecha después:', datosCompletos.fecha);

    const xmlGenerado = await FacturaElectronicaPY.generateXMLDE(params, datosCompletos, {});
    await reportarProgreso(35);

    // ========================================
    // 5. Firmar XML y extraer DigestValue + CDC
    // ========================================
    console.log('✍️  Firmando XML...');
    const rutaCertificado = empresa.obtenerRutaCertificado();
    const contrasena = certificadoService.descifrarContrasena(empresa.certificado.contrasena);

    const xmlFirmado = await xmlsign.signXML(xmlGenerado, rutaCertificado, contrasena);
    console.log('✅ XML firmado exitosamente');
    
    // EXTRAER DigestValue y CDC INMEDIATAMENTE (antes de enviar a SET)
    try {
      const xml2js = require('xml2js');
      const xmlFirmadoObj = await xml2js.parseStringPromise(xmlFirmado);

      // Extraer DigestValue de la firma digital
      // La estructura es: rDE > Signature > SignedInfo > Reference > DigestValue
      if (xmlFirmadoObj?.rDE?.Signature?.[0]?.SignedInfo?.[0]?.Reference?.[0]?.DigestValue?.[0]) {
        digestValueFirma = xmlFirmadoObj.rDE.Signature[0].SignedInfo[0].Reference[0].DigestValue[0];
        console.log(`🔐 DigestValue extraído: ${digestValueFirma}`);
      } else {
        console.warn('⚠️ No se encontró DigestValue en el XML firmado');
      }

      // Extraer CDC (Código de Control) del atributo Id del elemento DE
      // Ejemplo: <DE Id="01036040761001001000000322026022719876543220">
      if (xmlFirmadoObj?.rDE?.DE?.[0]?.$?.Id) {
        cdcFirma = xmlFirmadoObj.rDE.DE[0].$.Id;
        console.log(`🔢 CDC extraído (atributo Id): ${cdcFirma}`);
      } else if (xmlFirmadoObj?.['rDE:DE']?.[0]?.$?.Id) {
        cdcFirma = xmlFirmadoObj['rDE:DE'][0].$.Id;
        console.log(`🔢 CDC extraído (atributo Id namespace): ${cdcFirma}`);
      } else {
        console.warn('⚠️ No se encontró CDC en el atributo Id del DE');
        console.log('🔍 Estructura del XML:', Object.keys(xmlFirmadoObj));
        // Log más detallado para debugging
        if (xmlFirmadoObj?.rDE?.DE?.[0]) {
          console.log('📋 DE attributes:', xmlFirmadoObj.rDE.DE[0].$);
        }
      }

      // GUARDAR DigestValue y CDC EN BD INMEDIATAMENTE
      if (invoiceId) {
        try {
          const Invoice = require('../models/Invoice');
          const updateData = {};
          if (digestValueFirma) updateData.digestValue = digestValueFirma;
          if (cdcFirma) updateData.cdc = cdcFirma;

          if (Object.keys(updateData).length > 0) {
            await Invoice.findByIdAndUpdate(invoiceId, {
              ...updateData,
              estadoSifen: 'enviado'  // Cambiar a 'enviado' mientras se procesa en SET
            });
            console.log(`✅ DigestValue y CDC guardados en BD para factura ${invoiceId}`);
            console.log(`   DigestValue: ${digestValueFirma?.substring(0, 20)}...`);
            console.log(`   CDC: ${cdcFirma}`);
          } else {
            console.warn('⚠️ No hay datos para guardar en BD');
          }
        } catch (dbErr) {
          console.warn('⚠️ No se pudo guardar en BD:', dbErr.message);
        }
      }
    } catch (err) {
      console.warn('⚠️ No se pudo extraer datos del XML firmado:', err.message);
      console.error(err);
    }
    
    await reportarProgreso(50);

    // ========================================
    // 6. Generar y agregar QR
    // ========================================
    console.log('📱 Generando QR...');
    const idCSC = empresa.configuracionSifen.idCSC || '0001';
    const CSC = empresa.configuracionSifen.csc || 'ABCD0000000000000000000000000000';
    const ambiente = empresa.configuracionSifen.modo || 'test';

    const xmlConQR = await qr.generateQR(xmlFirmado, idCSC, CSC, ambiente);
    console.log('✅ QR generado e incrustado');
    await reportarProgreso(60);

    // ========================================
    // 7. GUARDAR XML INMEDIATAMENTE (ANTES DE ENVIAR A SET)
    // ========================================
    // CRÍTICO: Guardar el XML firmado ANTES de enviar a SET para no perderlo si falla la conexión
    const fecha = new Date();
    const anio = fecha.getFullYear();
    const mes = String(fecha.getMonth() + 1).padStart(2, '0');
    const rutaSalida = path.join(__dirname, `../de_output/${anio}/${mes}`);

    if (!fs.existsSync(rutaSalida)) {
      fs.mkdirSync(rutaSalida, { recursive: true });
    }

    const correlativo = datosCompletos.encabezado?.idDoc?.correlativo ||
                       `${establecimiento}-001-${String(datosCompletos.numero || '0000001').padStart(7, '0')}`;

    // Extraer datos del XML para el nombre del archivo
    let tipoDocumentoDescripcion = 'Factura';
    let serieDelXML = null;

    try {
      const xml2js = require('xml2js');
      const xmlObj = await xml2js.parseStringPromise(xmlConQR);
      if (xmlObj?.rDE?.DE?.[0]?.gTimb?.[0]?.dDesTiDE?.[0]) {
        tipoDocumentoDescripcion = xmlObj.rDE.DE[0].gTimb[0].dDesTiDE[0];
        console.log(`📋 Tipo de documento del XML: ${tipoDocumentoDescripcion}`);
      }
      if (xmlObj?.rDE?.DE?.[0]?.gInfDoc?.[0]?.gSerieNum?.[0]?.dSerieNum?.[0]) {
        serieDelXML = xmlObj.rDE.DE[0].gInfDoc[0].gSerieNum[0].dSerieNum[0];
        console.log(`📋 Serie del XML: ${serieDelXML}`);
      }
    } catch (err) {
      console.warn('⚠️ No se pudo extraer dDesTiDE del XML:', err.message);
    }

    // Construir nombre del archivo
    const timbradoStr = datosCompletos.timbrado || datosCompletos.encabezado?.idDoc?.dNumTim || timbrado;
    const establecimientoStr = (datosCompletos.establecimiento?.toString() || datosCompletos.encabezado?.idDoc?.dEst?.toString() || establecimiento).padStart(3, '0');
    const puntoStr = (datosCompletos.punto?.toString() || datosCompletos.encabezado?.idDoc?.dPunExp?.toString() || puntoEmision).padStart(3, '0');
    const numeroStr = (datosCompletos.numero?.toString() || datosCompletos.encabezado?.idDoc?.numDoc?.toString() || '0000001').padStart(7, '0');

    let nombreArchivo = `${tipoDocumentoDescripcion}_${timbradoStr}-${establecimientoStr}-${puntoStr}-${numeroStr}`;
    if (serieDelXML) {
      nombreArchivo += `-${serieDelXML}`;
    }
    nombreArchivo += '.xml';

    const rutaArchivo = path.join(rutaSalida, nombreArchivo);
    fs.writeFileSync(rutaArchivo, xmlConQR, 'utf8');

    const xmlPathRelativo = `${anio}/${mes}/${nombreArchivo}`;
    console.log(`📁 XML guardado: ${rutaArchivo}`);
    await reportarProgreso(70);

    // ========================================
    // 9. Enviar a SET - AHORA EL XML YA ESTÁ GUARDADO
    // ========================================
    console.log('📤 Enviando a SET...');
    const idDocumento = crypto.randomBytes(16).toString('hex');

    let soapResponse = null;
    let errorEnvio = null;

    try {
      soapResponse = await setApi.recibe(
        idDocumento,
        xmlConQR,
        ambiente,
        rutaCertificado,
        contrasena
      );
      console.log('📄 Respuesta SET recibida');
      await reportarProgreso(75);
    } catch (setErr) {
      // ⚠️ ERROR DE CONEXIÓN: No perder el XML ya generado
      errorEnvio = setErr;
      console.warn('⚠️ Error enviando a SET:', setErr.message);
      console.warn('⚠️ El XML firmado ya está guardado en:', rutaArchivo);
      
      // Continuar con estado de error
      soapResponse = null;
    }

    // ========================================
    // 10. Extraer datos de respuesta (o usar valores por error)
    // ========================================
    let codigoRetorno = '0000';
    let mensajeRetorno = null;
    let digestValueRespuesta = null;  // De la respuesta SOAP
    let fechaProceso = null;
    let estadoResultado = null;
    let estadoSifen = 'enviado';

    if (soapResponse) {
      codigoRetorno = extraerCodigoRetorno(soapResponse);
      mensajeRetorno = extraerMensajeRetorno(soapResponse);
      digestValueRespuesta = extraerDigestValue(soapResponse);
      fechaProceso = extraerFechaProceso(soapResponse);
      estadoResultado = extraerEstadoResultado(soapResponse);
      estadoSifen = determinarEstadoSegunCodigo(codigoRetorno);
      console.log(`📋 Código: ${codigoRetorno}, Estado: ${estadoSifen}`);
    } else {
      // Error de conexión: establecer estado de error
      estadoSifen = 'error';
      mensajeRetorno = errorEnvio?.message || 'Error de conexión con SET';
      codigoRetorno = '9999';
      console.log(`❌ Estado: ${estadoSifen} - ${mensajeRetorno}`);
    }

    // Calcular estado visual para el frontend (colores)
    const estadoVisual = determinarEstadoVisual(codigoRetorno);

    await reportarProgreso(80);

    // ========================================
    // 11. Retornar resultado
    // ========================================
    // NOTA: El CDC y DigestValue ya fueron guardados en BD después de firmar el XML
    return {
      success: true,
      cdc: cdcFirma,  // CDC extraído después de firmar
      xmlPath: xmlPathRelativo,  // Para BD
      xmlContent: xmlConQR,
      rutaArchivo: rutaArchivo,  // Ruta absoluta para KUDE
      estado: estadoSifen,
      estadoVisual: estadoVisual,  // Para colores en frontend
      codigoRetorno: codigoRetorno,
      mensajeRetorno: mensajeRetorno,
      digestValue: digestValueFirma,  // DigestValue extraído después de firmar
      fechaProceso: fechaProceso,
      correlativo: correlativo,
      rutaArchivo: rutaArchivo
    };

  } catch (error) {
    console.error('❌ Error procesando factura:', error);
    throw error;
  }
}

/**
 * Generar KUDE (PDF) desde XML
 * El JAR genera el PDF con el nombre: {tipoDocumento}_{timbrado}-{establecimiento}-{punto}-{numero}[-{serie}].pdf
 * Ejemplo: Factura electrónica_12345678-001-001-0000062.pdf
 * 
 * IMPORTANTE: El JAR no soporta espacios en la ruta, usamos enlace simbólico temporal
 */
async function generarKUDE(xmlPath, cdc, correlativo, fechaCreacion, datosFactura = null, empresa = null) {
  try {
    console.log('📄 Generando KUDE...');

    const fs = require('fs');
    const path = require('path');
    const java8Path = process.env.JAVA8_HOME || process.env.JAVA_HOME || 'java';
    const srcJasper =  path.join(__dirname, `../node_modules/facturacionelectronicapy-kude/dist/DE/`);

    const destFolder = path.join(__dirname, `../de_output`,
                                  fechaCreacion.getFullYear().toString(),
                                  String(fechaCreacion.getMonth() + 1).padStart(2, '0'), '/');
    const jsonParam = {
      ambiente: "1",
      LOGO_URL: empresa?.configuracionSifen?.urlLogo || "https://lrtv.jaranetwork.com/sites/default/files/styles/poster/public/logos/hit.png?itok=UHWpjKPdd",
      active: true
    };
    const jsonPDF = JSON.stringify(jsonParam);

    // ========================================
    // CREAR ARCHIVO TEMPORAL SIN ESPACIOS PARA EL JAR
    // ========================================
    // Crear nombre temporal SIN espacios ni caracteres especiales
    const nombreTemporal = `xml_temp_${Date.now()}.xml`;
    const dirTemporal = path.dirname(xmlPath);
    const rutaTemporal = path.join(dirTemporal, nombreTemporal);
    let archivoTemporal = null;
    
    // Copiar el archivo a un nombre temporal sin espacios
    try {
      fs.copyFileSync(xmlPath, rutaTemporal);
      archivoTemporal = rutaTemporal;
      console.log(`📋 Archivo copiado temporalmente: ${rutaTemporal}`);
    } catch (err) {
      console.error('❌ No se pudo copiar el archivo:', err.message);
      throw err;
    }

    // El JAR genera el PDF con su propio nombre basado en el XML
    const rutaParaJAR = archivoTemporal;
    await kude.generateKUDE(java8Path, rutaParaJAR, srcJasper, destFolder, JSON.stringify(jsonPDF));

    // Limpiar archivo temporal
    if (archivoTemporal && fs.existsSync(archivoTemporal)) {
      try {
        fs.unlinkSync(archivoTemporal);
        console.log('🧹 Archivo temporal eliminado');
      } catch (err) {
        // Ignorar error al limpiar
      }
    }

    // ========================================
    // BUSCAR EL PDF GENERADO POR EL JAR
    // ========================================
    // El JAR genera: {TipoDocumento}_{timbrado}-{establecimiento}-{punto}-{numero}[-{serie}].pdf
    // Ejemplo: Factura electrónica_12345678-001-001-0000001.pdf
    
    // Extraer timbrado del XML
    let timbrado = '12345678';
    try {
      const xml2js = require('xml2js');
      const xmlContent = fs.readFileSync(xmlPath, 'utf-8');
      const xmlObj = await xml2js.parseStringPromise(xmlContent);
      
      if (xmlObj?.rDE?.DE?.[0]?.gTimb?.[0]?.dNumTim?.[0]) {
        timbrado = xmlObj.rDE.DE[0].gTimb[0].dNumTim[0];
      }
    } catch (err) {
      console.warn('⚠️ No se pudo extraer timbrado del XML:', err.message);
    }
    
    // Extraer establecimiento, punto y número DIRECTAMENTE de datosFactura
    // para evitar inconsistencias entre el correlativo y los datos reales del JSON
    let establecimientoStr, puntoStr, numeroFactura;

    if (datosFactura) {
      // Intentar extraer de datosFactura.data (estructura ERPNext)
      const datosData = datosFactura.data || datosFactura;
      establecimientoStr = String(datosData.establecimiento || '001').padStart(3, '0');
      puntoStr = String(datosData.punto || '001').padStart(3, '0');
      numeroFactura = String(datosData.numero || correlativo.split('-')[2] || '0000001').padStart(7, '0');
    } else if (correlativo.includes('-')) {
      // Fallback: formato con guiones: 001-001-0000001
      const partes = correlativo.split('-');
      establecimientoStr = partes[0];
      puntoStr = partes[1];
      numeroFactura = partes[2];
    } else {
      // Fallback: formato sin guiones: 0010010000001
      establecimientoStr = correlativo.substring(0, 3);
      puntoStr = correlativo.substring(3, 6);
      numeroFactura = correlativo.substring(6);
    }
    
    // Construir nombre base del PDF
    // Nota: El JAR usa encoding Windows-1252 para caracteres especiales
    // "ó" se convierte en los bytes C3 B3 que se muestran como "├│" en UTF-8
    const pdfFileNameBase = `Factura electrónica_${timbrado}-${establecimientoStr}-${puntoStr}-${numeroFactura}`;
    
    // Versión alternativa con el encoding que usa el JAR (UTF-8 mal interpretado)
    // "ó" (U+00F3) en UTF-8 es C3 B3, que en Latin-1/Windows-1252 se ve como "Ã³"
    // Pero el JAR parece usar box-drawing characters: "│" (U+2502)
    const pdfFileNameBaseAlt = `Factura electr\u251C\u2502nica_${timbrado}-${establecimientoStr}-${puntoStr}-${numeroFactura}`;

    console.log('📄 Buscando PDF generado:', pdfFileNameBase);
    console.log('   Timbrado:', timbrado, '| Est:', establecimientoStr, '| Punto:', puntoStr, '| Número:', numeroFactura);

    // Buscar el PDF en la carpeta
    const files = fs.readdirSync(destFolder);
    
    // Intentar múltiples patrones de búsqueda
    let pdfFile = files.find(f => f.endsWith('.pdf') && f.startsWith(pdfFileNameBase));
    
    // Si no encuentra, intentar con encoding alternativo
    if (!pdfFile) {
      pdfFile = files.find(f => f.endsWith('.pdf') && f.startsWith(pdfFileNameBaseAlt));
    }
    
    // Si aún no encuentra, buscar por patrón flexible (timbrado y correlativo)
    if (!pdfFile) {
      const pattern = new RegExp(`^Factura.*_${timbrado}-${establecimientoStr}-${puntoStr}-${numeroFactura}\\.pdf$`);
      pdfFile = files.find(f => pattern.test(f));
    }

    if (pdfFile) {
      const pdfPath = path.join(destFolder, pdfFile);
      console.log(`✅ KUDE generado: ${pdfPath}`);
      return pdfPath;
    } else {
      console.warn('⚠️ Archivos en carpeta:', files.filter(f => f.endsWith('.pdf')));
      throw new Error(`PDF no encontrado: ${pdfFileNameBase}.pdf`);
    }

  } catch (error) {
    console.warn('⚠️ Error generando KUDE:', error.message);
    return null;
  }
}

/**
 * Completar datos con configuración de empresa
 */
function completarDatosConEmpresa(datosFactura, empresa) {
  const datosCompletos = { ...datosFactura };
  const timbrado = empresa.configuracionSifen.timbrado || '12345678';
  
  // Extraer establecimiento y punto del JSON, con fallback a '001'
  const establecimiento = String(datosFactura.data?.establecimiento || datosFactura.establecimiento || '001').padStart(3, '0');
  const puntoEmision = String(datosFactura.data?.punto || datosFactura.punto || '001').padStart(3, '0');

  // Agregar RUC de la empresa (importante para CDC)
  datosCompletos.ruc = empresa.ruc;  // Con guión para xmlgen

  // Completar campos requeridos
  if (!datosCompletos.tipoDocumento) datosCompletos.tipoDocumento = 1;
  if (!datosCompletos.tipoImpuesto) datosCompletos.tipoImpuesto = 1;
  if (!datosCompletos.condicionAnticipo) datosCompletos.condicionAnticipo = 1;
  if (!datosCompletos.condicionTipoCambio) datosCompletos.condicionTipoCambio = 1;
  if (datosCompletos.descuentoGlobal === undefined) datosCompletos.descuentoGlobal = 0;
  if (datosCompletos.anticipoGlobal === undefined) datosCompletos.anticipoGlobal = 0;
  if (!datosCompletos.cambio) datosCompletos.cambio = 6700;

  // Usuario
  if (!datosCompletos.usuario) {
    datosCompletos.usuario = {
      documentoTipo: 1,
      documentoNumero: "0",
      nombre: "Sistema",
      cargo: "Emisor"
    };
  }

  // Factura - Preservar fechaEnvio si viene en el JSON
  if (!datosCompletos.factura) {
    datosCompletos.factura = { presencia: 1 };
  } else if (!datosCompletos.factura.presencia) {
    datosCompletos.factura.presencia = 1;
  }
  // NOTA: No sobrescribir fechaEnvio si ya viene en el JSON

  // Condición
  if (!datosCompletos.condicion) {
    datosCompletos.condicion = {
      tipo: 1,
      entregas: [{
        tipo: 1,
        monto: String(datosCompletos.totalPago || 0),
        moneda: datosCompletos.moneda || "PYG",
        cambio: 0
      }]
    };
  }

  // Encabezado
  if (!datosCompletos.encabezado) {
    datosCompletos.encabezado = {
      idDoc: {
        tipDoc: datosCompletos.tipoDocumento || 1,
        dNumTim: timbrado,
        dEst: establecimiento,
        dPunExp: puntoEmision,
        numDoc: datosCompletos.numero || '0000001',
        correlativo: `${establecimiento}${puntoEmision}${String(datosCompletos.numero || '0000001').padStart(7, '0')}`
      },
      infoEmi: {
        tipoRegimen: 1,
        contribuyente: true,
        clasifActivEcon: 1,
        destinoComprobante: 1,
        sujetoExcluido: false,
        responsableIVA: true
      },
      // Formato SIFEN v150: YYYY-MM-DDTHH:MM:SS (sin milisegundos ni Z)
      fecha: formatoFechaSIFEN(datosCompletos.fecha)
    };
  }

  return datosCompletos;
}

module.exports = {
  procesarFactura,
  generarKUDE,
  completarDatosConEmpresa
};
