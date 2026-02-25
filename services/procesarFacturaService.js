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
const { normalizarDatetime, formatoFechaSIFEN, convertirFechasASIFEN } = require('../utils/fechaUtils');

// Librerías SIFEN
const FacturaElectronicaPY = require('facturacionelectronicapy-xmlgen').default;
const xmlsign = require('facturacionelectronicapy-xmlsign').default;
const qr = require('facturacionelectronicapy-qrgen').default;
const kude = require('facturacionelectronicapy-kude').default;
const setApi = require('../../mock-set/setapi-mock').default;

/**
 * Procesa una factura electrónica completa
 * @param {Object} datosFactura - Datos de la factura
 * @param {String} empresaId - ID de la empresa
 * @param {Object} job - Job de Bull (para reportar progreso)
 * @returns {Object} Resultado del procesamiento
 */
async function procesarFactura(datosFactura, empresaId, job = null) {
  const reportarProgreso = async (progress) => {
    if (job && job.progress) {
      await job.progress(progress);
    }
  };

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
    const datosCompletos = completarDatosConEmpresa(datosFactura, empresa);
    await reportarProgreso(15);

    // ========================================
    // 3. Generar CDC (Código de Control)
    // ========================================
    const cdcGenerado = generarCDC(datosCompletos);
    console.log(`🔢 CDC generado: ${cdcGenerado}`);
    datosCompletos.cdc = cdcGenerado;
    await reportarProgreso(20);

    // ========================================
    // 4. Generar params para xmlgen
    // ========================================
    const timbrado = datosCompletos.timbrado || empresa.configuracionSifen.timbrado || '12345678';
    const establecimiento = '001';
    
    const params = {
      version: 150,
      ruc: empresa.ruc,  // Con guión para xmlgen
      razonSocial: empresa.razonSocial || empresa.nombreFantasia,
      nombreFantasia: empresa.nombreFantasia,
      actividadesEconomicas: [{
        codigo: "1254",
        descripcion: "Desarrollo de Software"
      }],
      timbradoNumero: timbrado,
      timbradoFecha: datosCompletos.fecha ? new Date(normalizarDatetime(datosCompletos.fecha)).toISOString().split('T')[0] : "2021-10-19",
      tipoContribuyente: 1,
      tipoRegimen: 1,
      establecimientos: [{
        codigo: establecimiento,
        denominacion: "MATRIZ",
        direccion: empresa.direccion || "N/A",
        numeroCasa: "1",
        departamento: 11,
        departamentoDescripcion: "ALTO PARANA",
        distrito: 145,
        distritoDescripcion: "CIUDAD DEL ESTE",
        ciudad: 3432,
        ciudadDescripcion: "PUERTO PTE.STROESSNER (MUNIC)",
        telefono: empresa.telefono || "0973-527155",
        email: empresa.email || "tips@tips.com.py"
      }]
    };

    await reportarProgreso(25);

    // ========================================
    // 5. Generar XML
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
    // 6. Firmar XML
    // ========================================
    console.log('✍️  Firmando XML...');
    const rutaCertificado = empresa.obtenerRutaCertificado();
    const contrasena = certificadoService.descifrarContrasena(empresa.certificado.contrasena);
    
    const xmlFirmado = await xmlsign.signXML(xmlGenerado, rutaCertificado, contrasena);
    console.log('✅ XML firmado exitosamente');
    await reportarProgreso(50);

    // ========================================
    // 7. Generar y agregar QR
    // ========================================
    console.log('📱 Generando QR...');
    const idCSC = empresa.configuracionSifen.idCSC || '0001';
    const CSC = empresa.configuracionSifen.csc || 'ABCD0000000000000000000000000000';
    const ambiente = empresa.configuracionSifen.modo || 'test';
    
    const xmlConQR = await qr.generateQR(xmlFirmado, idCSC, CSC, ambiente);
    console.log('✅ QR generado e incrustado');
    await reportarProgreso(60);

    // ========================================
    // 8. Enviar a SET (o mock)
    // ========================================
    console.log('📤 Enviando a SET...');
    const idDocumento = crypto.randomBytes(16).toString('hex');
    
    const soapResponse = await setApi.recibe(
      idDocumento,
      xmlConQR,
      ambiente,
      rutaCertificado,
      contrasena
    );

    console.log('📄 Respuesta SET recibida');
    await reportarProgreso(75);

    // ========================================
    // 9. Extraer datos de respuesta
    // ========================================
    const codigoRetorno = extraerCodigoRetorno(soapResponse);
    const mensajeRetorno = extraerMensajeRetorno(soapResponse);
    const digestValue = extraerDigestValue(soapResponse);
    const fechaProceso = extraerFechaProceso(soapResponse);
    const estadoResultado = extraerEstadoResultado(soapResponse);
    
    const estadoSifen = determinarEstadoSegunCodigoRetorno(codigoRetorno, estadoResultado, mensajeRetorno);
    
    console.log(`📋 Código: ${codigoRetorno}, Estado: ${estadoSifen}`);
    await reportarProgreso(80);

    // ========================================
    // 10. Guardar XML en filesystem
    // ========================================
    const fecha = new Date();
    const anio = fecha.getFullYear();
    const mes = String(fecha.getMonth() + 1).padStart(2, '0');
    // Ruta: backend/de_output
    const rutaSalida = path.join(__dirname, `../de_output/${anio}/${mes}`);

    if (!fs.existsSync(rutaSalida)) {
      fs.mkdirSync(rutaSalida, { recursive: true });
    }

    const correlativo = datosCompletos.encabezado?.idDoc?.correlativo ||
                       `${establecimiento}001${String(datosCompletos.numero || '0000001').padStart(7, '0')}`;
    
    // ========================================
    // EXTRAER tipoDocumentoDescripcion DEL XML FIRMANDO PRIMERO
    // (igual que server.js - antes de guardar el archivo)
    // ========================================
    let tipoDocumentoDescripcion = 'Factura';  // Default como server.js
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

    // ========================================
    // CONSTRUIR NOMBRE CORRECTO DESDE EL PRINCIPIO
    // ========================================
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
    fs.writeFileSync(rutaArchivo, xmlConQR);

    const xmlPath = rutaArchivo;  // Ruta absoluta para KUDE
    const xmlPathRelativo = `${anio}/${mes}/${nombreArchivo}`;  // Para BD
    console.log(`📁 XML guardado: ${xmlPath}`);
    await reportarProgreso(90);

    // ========================================
    // 11. Retornar resultado
    // ========================================
    return {
      success: true,
      cdc: cdcGenerado,
      xmlPath: xmlPathRelativo,  // Para BD
      xmlContent: xmlConQR,
      rutaArchivo: rutaArchivo,  // Ruta absoluta para KUDE
      estado: estadoSifen,
      codigoRetorno: codigoRetorno,
      mensajeRetorno: mensajeRetorno,
      digestValue: digestValue,
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
async function generarKUDE(xmlPath, cdc, correlativo, fechaCreacion, datosFactura = null) {
  try {
    console.log('📄 Generando KUDE...');

    const fs = require('fs');
    const path = require('path');
    const java8Path = process.env.JAVA8_HOME || process.env.JAVA_HOME || 'java';
    const srcJasper = '/home/ruben/sifen_einvoice/proyecto-sifen/fepy-backend/node_modules/facturacionelectronicapy-kude/dist/DE/';
    const destFolder = path.join(__dirname, `../de_output`,
                                  fechaCreacion.getFullYear().toString(),
                                  String(fechaCreacion.getMonth() + 1).padStart(2, '0'), '/');

    const jsonParam = {
      ambiente: "1",
      LOGO_URL: "https://lrtv.jaranetwork.com/sites/default/files/styles/poster/public/logos/hit.png?itok=UHWpjKPdd",
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
    // BUSCAR EL PDF REAL GENERADO POR EL JAR
    // El JAR usa: {dDesTiDE}_{timbrado}-{establecimiento}-{punto}-{numero}[-{serie}].pdf
    // ========================================

    // Extraer timbrado, establecimiento, punto y número del XML
    let pdfTimbrado = '12345678';
    let pdfEstablecimiento = '001';
    let pdfPunto = '001';
    let pdfNumero = '0000001';
    let pdfTipoDocumento = 'Factura electrónica';  // Default exacto como el JAR

    try {
      const xml2js = require('xml2js');
      const xmlContent = fs.readFileSync(xmlPath, 'utf-8');
      const xmlObj = await xml2js.parseStringPromise(xmlContent);
      
      // Extraer tipo de documento EXACTO como el JAR (con UTF-8)
      if (xmlObj?.rDE?.DE?.[0]?.gTimb?.[0]?.dDesTiDE?.[0]) {
        pdfTipoDocumento = xmlObj.rDE.DE[0].gTimb[0].dDesTiDE[0];
        // NO reemplazar caracteres - mantener UTF-8 exacto
      }
      
      // Extraer timbrado
      if (xmlObj?.rDE?.DE?.[0]?.gTimb?.[0]?.dNumTim?.[0]) {
        pdfTimbrado = xmlObj.rDE.DE[0].gTimb[0].dNumTim[0];
      }
      
      // Extraer establecimiento, punto y número
      if (xmlObj?.rDE?.DE?.[0]?.gInfDoc?.[0]) {
        const gInfDoc = xmlObj.rDE.DE[0].gInfDoc[0];
        if (gInfDoc.gEst?.[0]?.dEst?.[0]) pdfEstablecimiento = gInfDoc.gEst[0].dEst[0];
        if (gInfDoc.gPunExp?.[0]?.dPunExp?.[0]) pdfPunto = gInfDoc.gPunExp[0].dPunExp[0];
        if (gInfDoc.gNumDoc?.[0]?.dNumDoc?.[0]) pdfNumero = gInfDoc.gNumDoc[0].dNumDoc[0];
      }
    } catch (err) {
      console.warn('⚠️ No se pudo extraer datos del XML para el PDF:', err.message);
    }

    // Construir el nombre EXACTO que genera el JAR (con UTF-8)
    const pdfFileNameBase = `${pdfTipoDocumento}_${pdfTimbrado}-${pdfEstablecimiento}-${pdfPunto}-${pdfNumero}`;
    
    // Buscar el PDF real en la carpeta
    const files = fs.readdirSync(destFolder);
    console.log('📂 Archivos en carpeta:', files.filter(f => f.endsWith('.pdf')));
    console.log('🔍 Buscando:', pdfFileNameBase);
    
    // Primero buscar coincidencia exacta
    let pdfFile = files.find(f => f.endsWith('.pdf') && f.startsWith(pdfFileNameBase));
    
    // Si no encuentra, buscar por timbrado y número
    if (!pdfFile) {
      pdfFile = files.find(f => 
        f.endsWith('.pdf') && 
        f.includes(pdfTimbrado) && 
        f.includes(`-${pdfPunto}-${pdfNumero}.pdf`)
      );
    }
    
    // Si todavía no encuentra, buscar cualquier PDF con el número de factura
    if (!pdfFile) {
      pdfFile = files.find(f => 
        f.endsWith('.pdf') && 
        f.includes(pdfNumero)
      );
    }

    if (pdfFile) {
      const pdfPath = path.join(destFolder, pdfFile);
      console.log(`✅ KUDE generado: ${pdfPath}`);
      console.log(`   Nombre real: ${pdfFile}`);
      return pdfPath;
    } else {
      console.warn('⚠️ Archivos en la carpeta:', files);
      throw new Error(`PDF no encontrado. Buscaba: ${pdfFileNameBase}.pdf`);
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
  const establecimiento = '001';
  const puntoEmision = '001';

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

  // Factura
  if (!datosCompletos.factura) {
    datosCompletos.factura = { presencia: 1 };
  }

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

/**
 * Generar CDC según SIFEN v150
 */
function generarCDC(datosFactura) {
  const tipoDocumento = String(datosFactura.tipoDocumento || 1).padStart(2, '0');

  // Usar el RUC de datosFactura.ruc o datosFactura.emisor.ruc
  const rucCompleto = (datosFactura.ruc || datosFactura.emisor?.ruc || '8001234-5').toString().replace(/-/g, '');
  const rucEmisor = rucCompleto.substring(0, 8).padStart(8, '0');
  const dvEmisor = rucCompleto.substring(8, 9) || '1';

  const establecimiento = String(datosFactura.establecimiento || '001').padStart(3, '0');
  const puntoExp = String(datosFactura.punto || '001').padStart(3, '0');
  const numeroDoc = String(datosFactura.numero || '0000001').padStart(7, '0');
  const tipoContribuyente = '1';

  let fechaEmision;
  if (datosFactura.fecha) {
    // Normalizar fecha de ERPNext (microsegundos → milisegundos)
    const fechaNormalizada = normalizarDatetime(datosFactura.fecha);
    const f = new Date(fechaNormalizada);
    fechaEmision = `${f.getFullYear()}${String(f.getMonth() + 1).padStart(2, '0')}${String(f.getDate()).padStart(2, '0')}`;
  } else {
    const now = new Date();
    fechaEmision = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  }

  const tipoEmision = String(datosFactura.tipoEmision || 1).padStart(1, '0');
  const codigoSeguridad = String(datosFactura.codigoSeguridadAleatorio || Math.floor(Math.random() * 900000000)).padStart(9, '0');

  // Construir CDC sin DV
  const cdcSinDV = `${tipoDocumento}${rucEmisor}${dvEmisor}${establecimiento}${puntoExp}${numeroDoc}${tipoContribuyente}${fechaEmision}${tipoEmision}${codigoSeguridad}`;

  // Calcular DV (módulo 11)
  const dv = calcularDV(cdcSinDV);

  return `${cdcSinDV}${dv}`;
}

/**
 * Calcular dígito verificador (módulo 11)
 */
function calcularDV(cdc) {
  let suma = 0;
  let multiplicador = 2;
  
  for (let i = cdc.length - 1; i >= 0; i--) {
    suma += parseInt(cdc[i]) * multiplicador;
    multiplicador = multiplicador >= 7 ? 2 : multiplicador + 1;
  }
  
  const resto = suma % 11;
  const dv = resto === 0 ? 0 : (resto === 1 ? 1 : 11 - resto);
  
  return String(dv);
}

/**
 * Extraer datos de respuesta SOAP
 */
function extraerCodigoRetorno(xml) {
  const match = xml.match(/<codigoRetorno>(.*?)<\/codigoRetorno>/);
  return match?.[1]?.trim() || '0000';
}

function extraerMensajeRetorno(xml) {
  const match = xml.match(/<mensajeRetorno>(.*?)<\/mensajeRetorno>/);
  return match?.[1]?.trim() || null;
}

function extraerDigestValue(xml) {
  const match = xml.match(/<digestValue>(.*?)<\/digestValue>/);
  return match?.[1]?.trim() || null;
}

function extraerFechaProceso(xml) {
  const match = xml.match(/<fechaProceso>(.*?)<\/fechaProceso>/);
  return match?.[1]?.trim() || null;
}

function extraerEstadoResultado(xml) {
  const match = xml.match(/<estadoResultado>(.*?)<\/estadoResultado>/);
  return match?.[1]?.trim() || null;
}

function determinarEstadoSegunCodigoRetorno(codigo, estadoResultado, mensaje) {
  if (!codigo) return 'enviado';
  if (['0000', '0', '2', '0421'].includes(codigo)) return 'aceptado';
  if (['3', '0003'].includes(codigo)) return 'procesando';
  if (['1000', '1001', '1002', '1003', '1004', '1'].includes(codigo)) return 'rechazado';
  return 'enviado';
}

module.exports = {
  procesarFactura,
  generarKUDE,
  completarDatosConEmpresa,
  generarCDC,
  calcularDV
};
