/**
 * Servidor para generar facturas electrónicas en XML para Paraguay
 * Con integración de base de datos MongoDB para registro de operaciones
 */

require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');

// Importar librerías de facturación electrónica (se usan en procesarFacturaService.js)
// const FacturaElectronicaPY = require('facturacionelectronicapy-xmlgen').default;
// const xmlsign = require('facturacionelectronicapy-xmlsign').default;
// const kude = require('facturacionelectronicapy-kude').default;
// const qr = require('facturacionelectronicapy-qrgen').default;

// MODO MOCK: Usar el servidor mock de la SET
const setApi = require('../mock-set/setapi-mock').default;

// Configurar el mock (opcional, solo para debugging)
if (process.env.MOCK_DEBUG === 'true') {
  setApi.configure({ mockUrl: process.env.MOCK_SET_URL || 'http://localhost:8082', debug: true });
}

// Importar modelos
const Invoice = require('./models/Invoice');
const OperationLog = require('./models/OperationLog');

// Configurar Express
const app = express();

// Middleware para parsear JSON
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Importar rutas
const statsRoutes = require('./routes/stats');
const invoiceRoutes = require('./routes/invoices');
const authController = require('./controllers/authController');
const apiKeyController = require('./controllers/apiKeyController');
const { verificarToken, verificarAdmin } = require('./middleware/auth');

// Rutas de empresas
const empresaRoutes = require('./routes/empresas');
const facturarRoutes = require('./routes/facturar');
// const getEinvoiceRoute = require('./routes/get_einvoice');  // ← LEGACY: Usar /api/facturar/crear

// Usar rutas
app.use('/api/stats', statsRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/empresas', empresaRoutes);
app.use('/api/facturar', facturarRoutes);
// app.use(getEinvoiceRoute);  // ← LEGACY: Deshabilitado, usar /api/facturar/crear

// Rutas de autenticación (públicas)
app.post('/api/auth/login', authController.login);
// Rutas de autenticación (protegidas)
app.get('/api/auth/perfil', verificarToken, authController.getPerfil);
app.put('/api/auth/perfil', verificarToken, authController.actualizarPerfil);
app.post('/api/auth/cambiar-password', verificarToken, authController.cambiarPassword);
app.post('/api/auth/logout', verificarToken, authController.logout);

// Rutas de API Keys (protegidas, solo admin)
app.post('/api/api-keys', verificarToken, apiKeyController.crearApiKey);
app.get('/api/api-keys', verificarToken, apiKeyController.listarApiKeys);
app.get('/api/api-keys/:id', verificarToken, apiKeyController.obtenerApiKey);
app.put('/api/api-keys/:id/renew', verificarToken, apiKeyController.renovarApiKey);
app.delete('/api/api-keys/:id', verificarToken, apiKeyController.revocarApiKey);


// Conectar a MongoDB
const connectDB = async () => {
  try {
    await mongoose.connect('mongodb://localhost:27017/sifen_db', {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('✅ Conectado a MongoDB');
  } catch (error) {
    console.error('❌ Error conectando a MongoDB:', error.message);
    process.exit(1);
  }
};

// ========================================
// MIDDLEWARE DE CORS
// ========================================

// Middleware para manejar CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  next();
});

// Las rutas se definen después de las funciones auxiliares (ver línea ~1300)

// Ruta de ejemplo para probar el servidor
app.get('/get_einvoice', (req, res) => {
  res.json({
    mensaje: 'Servidor de facturación electrónica activo',
    endpoint: 'POST /get_einvoice',
    descripcion: 'Envía un objeto JSON con los datos de la factura para generar un archivo XML de factura electrónica'
  });
});

// Endpoint para consultar una factura específica por número de correlativo (requiere autenticación)
app.get('/check_invoice/:numero', verificarToken, async (req, res) => {
  try {
    const numeroFactura = req.params.numero;

    if (!numeroFactura) {
      res.status(400).json({ error: 'Número de factura requerido' });
      return;
    }

    // Primero buscar en la base de datos
    const invoiceRecord = await Invoice.findOne({ correlativo: numeroFactura });
    
    if (invoiceRecord) {
      // Si existe en BD, devolver información completa
      res.status(200).json({
        encontrado: true,
        enBaseDeDatos: true,
        datos: {
          _id: invoiceRecord._id,
          correlativo: invoiceRecord.correlativo,
          cdc: invoiceRecord.cdc,
          estadoSifen: invoiceRecord.estadoSifen,
          fechaCreacion: invoiceRecord.fechaCreacion,
          fechaEnvio: invoiceRecord.fechaEnvio,
          fechaProceso: invoiceRecord.fechaProceso,
          total: invoiceRecord.total,
          cliente: invoiceRecord.cliente
        }
      });
      return;
    }

    // Si no está en BD, buscar en los archivos XML
    const directorioSalida = path.join(__dirname, '../de_output');
    const fileName = `factura_${numeroFactura}.xml`;

    let facturaEncontrada = null;
    let rutaFactura = null;

    if (fs.existsSync(directorioSalida)) {
      const años = fs.readdirSync(directorioSalida);

      for (const year of años) {
        const yearPath = path.join(directorioSalida, year);
        if (fs.statSync(yearPath).isDirectory()) {
          const meses = fs.readdirSync(yearPath);

          for (const month of meses) {
            const monthPath = path.join(yearPath, month);
            if (fs.statSync(monthPath).isDirectory()) {
              const archivos = fs.readdirSync(monthPath);

              if (archivos.includes(fileName)) {
                rutaFactura = path.join(monthPath, fileName);
                facturaEncontrada = fs.readFileSync(rutaFactura, 'utf8');
                break;
              }
            }
          }

          if (facturaEncontrada) break;
        }
      }
    }

    if (facturaEncontrada) {
      res.status(200).json({
        encontrado: true,
        enBaseDeDatos: false,
        enArchivos: true,
        xml: facturaEncontrada
      });
    } else {
      res.status(404).json({ 
        encontrado: false,
        error: 'Factura no encontrada', 
        numero: numeroFactura 
      });
    }
  } catch (error) {
    console.error('Error al buscar factura:', error);
    res.status(500).json({ error: 'Error al buscar factura' });
  }
});

// Endpoint para consultar una factura por CDC (consulta en Mock SET a través del backend)
app.get('/api/invoices/cdc/:cdc', async (req, res) => {
  try {
    const cdc = req.params.cdc;

    if (!cdc) {
      res.status(400).json({ error: 'CDC requerido' });
      return;
    }

    // Primero buscar en la base de datos local
    const invoiceRecord = await Invoice.findOne({ cdc });
    
    if (invoiceRecord) {
      res.status(200).json({
        encontrado: true,
        fuente: 'local',
        datos: {
          _id: invoiceRecord._id,
          correlativo: invoiceRecord.correlativo,
          cdc: invoiceRecord.cdc,
          estadoSifen: invoiceRecord.estadoSifen,
          fechaCreacion: invoiceRecord.fechaCreacion,
          fechaEnvio: invoiceRecord.fechaEnvio,
          fechaProceso: invoiceRecord.fechaProceso,
          digestValue: invoiceRecord.digestValue,
          total: invoiceRecord.total,
          cliente: invoiceRecord.cliente,
          xmlPath: invoiceRecord.xmlPath
        }
      });
      return;
    }

    // Si no está en BD local, consultar al Mock SET (o SET real)
    try {
      const idConsulta = crypto.randomBytes(16).toString('hex');
      const ambiente = "test";
      const certificateP12Path = path.join(__dirname, '../certificados', 'p12', 'certificado.p12');
      const certificatePassword = '123456';

      const respuesta = await setApi.consulta(idConsulta, cdc, ambiente, certificateP12Path, certificatePassword);

      res.status(200).json({
        encontrado: true,
        fuente: 'sifen',
        respuesta: respuesta
      });
    } catch (error) {
      res.status(404).json({
        encontrado: false,
        error: 'CDC no encontrado en SIFEN',
        cdc: cdc
      });
    }
  } catch (error) {
    console.error('Error al consultar por CDC:', error);
    res.status(500).json({ error: 'Error al consultar por CDC' });
  }
});

// Endpoint para listar todas las facturas (con filtros opcionales)
app.get('/api/invoices', async (req, res) => {
  try {
    const { estado, cdc, correlativo, cliente, limit, skip } = req.query;

    // Construir filtro
    const filtro = {};
    if (estado) filtro.estadoSifen = estado;
    if (cdc) filtro.cdc = new RegExp(cdc, 'i');
    if (correlativo) filtro.correlativo = new RegExp(correlativo, 'i');
    if (cliente) filtro['cliente.nombre'] = new RegExp(cliente, 'i');

    // Opciones de paginación
    const opciones = {
      sort: { fechaCreacion: -1 },
      limit: parseInt(limit) || 50,
      skip: parseInt(skip) || 0
    };

    const facturas = await Invoice.find(filtro, null, opciones);

    res.status(200).json({
      total: facturas.length,
      filtros: filtro,
      facturas: facturas.map(f => ({
        _id: f._id,
        correlativo: f.correlativo,
        cdc: f.cdc,
        estadoSifen: f.estadoSifen,
        fechaCreacion: f.fechaCreacion,
        fechaEnvio: f.fechaEnvio,
        total: f.total,
        cliente: f.cliente
      }))
    });
  } catch (error) {
    console.error('Error al listar facturas:', error);
    res.status(500).json({ error: 'Error al listar facturas' });
  }
});

// Endpoint para consultar RUC a través del backend
app.get('/api/ruc/:ruc', async (req, res) => {
  try {
    const ruc = req.params.ruc;

    if (!ruc) {
      res.status(400).json({ error: 'RUC requerido' });
      return;
    }

    // Consultar al Mock SET (o SET real) a través del backend
    try {
      const idConsulta = crypto.randomBytes(16).toString('hex');
      const ambiente = "test";
      const certificateP12Path = path.join(__dirname, '../certificados', 'p12', 'certificado.p12');
      const certificatePassword = '123456';

      const respuesta = await setApi.consultaRuc(idConsulta, ruc, ambiente, certificateP12Path, certificatePassword);

      res.status(200).json({
        ruc: ruc,
        encontrado: true,
        respuesta: respuesta
      });
    } catch (error) {
      res.status(404).json({
        ruc: ruc,
        encontrado: false,
        error: 'RUC no encontrado o error en consulta'
      });
    }
  } catch (error) {
    console.error('Error al consultar RUC:', error);
    res.status(500).json({ error: 'Error al consultar RUC' });
  }
});

// Endpoint para obtener estadísticas del sistema
app.get('/api/stats', async (req, res) => {
  try {
    const totalFacturas = await Invoice.countDocuments();
    const facturasPorEstado = await Invoice.aggregate([
      { $group: { _id: '$estadoSifen', count: { $sum: 1 } } }
    ]);

    const facturasHoy = await Invoice.countDocuments({
      fechaCreacion: {
        $gte: new Date(new Date().setHours(0, 0, 0, 0)),
        $lt: new Date()
      }
    });

    const ultimasFacturas = await Invoice.find()
      .sort({ fechaCreacion: -1 })
      .limit(10)
      .select('correlativo cdc estadoSifen fechaCreacion total');

    res.status(200).json({
      totalFacturas,
      facturasPorEstado,
      facturasHoy,
      ultimasFacturas,
      uptime: process.uptime(),
      memoria: process.memoryUsage()
    });
  } catch (error) {
    console.error('Error al obtener estadísticas:', error);
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

// ========================================
// ENDPOINT: CONSULTAR ESTADO DE FACTURA (CON COLA)
// ========================================
app.get('/api/factura/estado/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Buscar factura en BD
    const invoice = await Invoice.findById(id);
    if (!invoice) {
      return res.status(404).json({
        success: false,
        error: 'Factura no encontrada'
      });
    }

    // Buscar job en la cola
    let jobStatus = null;
    let jobProgress = 0;
    let jobAttempts = 0;
    let failedReason = null;

    try {
      const { facturaQueue } = require('./queues/facturaQueue');
      const job = await facturaQueue.getJob(`factura-${id}`);

      if (job) {
        jobStatus = await job.getState();
        jobProgress = await job.progress();
        jobAttempts = job.attemptsMade || 0;

        if (jobStatus === 'failed') {
          failedReason = job.failedReason;
        }
      }
    } catch (queueError) {
      console.warn('⚠️ No se pudo obtener estado del job:', queueError.message);
    }

    res.json({
      success: true,
      data: {
        facturaId: invoice._id,
        correlativo: invoice.correlativo,
        estado: invoice.estadoSifen,
        cdc: invoice.cdc,
        codigoRetorno: invoice.codigoRetorno,
        mensajeRetorno: invoice.mensajeRetorno,
        fechaCreacion: invoice.fechaCreacion,
        fechaEnvio: invoice.fechaEnvio,
        job: {
          status: jobStatus,
          progress: jobProgress,
          attempts: jobAttempts,
          failedReason: failedReason
        }
      }
    });

  } catch (error) {
    console.error('Error consultando estado:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ========================================
// ENDPOINT: ESTADÍSTICAS DE LA COLA
// ========================================
app.get('/api/queue/stats', async (req, res) => {
  try {
    const { getQueueStats } = require('./queues/facturaQueue');
    const stats = await getQueueStats();

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint para obtener logs de operaciones
app.get('/api/logs', async (req, res) => {
  try {
    const { page = 1, limit = 15, estado, tipoOperacion, invoiceId } = req.query;
    
    const options = {
      page: parseInt(page),
      limit: parseInt(limit),
      sort: { fecha: -1 }
    };
    
    // Construir filtro
    const filtro = {};
    if (estado && estado !== 'all') {
      filtro.estado = estado;
    }
    if (tipoOperacion) {
      filtro.tipoOperacion = tipoOperacion;
    }
    if (invoiceId) {
      filtro.invoiceId = invoiceId;
    }
    
    const logs = await OperationLog.find(filtro)
      .sort(options.sort)
      .limit(options.limit)
      .populate('invoiceId', 'correlativo cdc estadoSifen');
    
    const total = await OperationLog.countDocuments(filtro);
    const totalPages = Math.ceil(total / options.limit);
    
    res.status(200).json({
      logs: logs.map(log => ({
        _id: log._id,
        invoiceId: log.invoiceId ? {
          _id: log.invoiceId._id,
          correlativo: log.invoiceId.correlativo,
          cdc: log.invoiceId.cdc,
          estadoSifen: log.invoiceId.estadoSifen
        } : null,
        tipoOperacion: log.tipoOperacion,
        descripcion: log.descripcion,
        estado: log.estado,
        fecha: log.fecha,
        detalle: log.detalle
      })),
      total,
      page: options.page,
      limit: options.limit,
      totalPages
    });
  } catch (error) {
    console.error('Error al obtener logs:', error);
    res.status(500).json({ error: 'Error al obtener logs' });
  }
});

// Endpoint para verificar el estado actual de una factura (incluyendo cambios de estado)
app.get('/api/invoices/estado/:cdc', async (req, res) => {
  try {
    const cdc = req.params.cdc;

    if (!cdc) {
      res.status(400).json({ error: 'CDC requerido' });
      return;
    }

    // Primero buscar en la base de datos local
    const invoiceRecord = await Invoice.findOne({ cdc });
    
    if (!invoiceRecord) {
      res.status(404).json({
        encontrado: false,
        error: 'Factura no encontrada en la base de datos local',
        cdc: cdc
      });
      return;
    }

    // Verificar si el estado ha cambiado consultando al Mock SET
    let estadoActual = invoiceRecord.estadoSifen;
    let estadoMockSet = null;

    try {
      // Consultar al Mock SET para ver el estado actual del documento
      const idConsulta = crypto.randomBytes(16).toString('hex');
      const ambiente = "test";
      const certificateP12Path = path.join(__dirname, '../certificados', 'p12', 'certificado.p12');
      const certificatePassword = '123456';

      const respuesta = await setApi.consulta(idConsulta, cdc, ambiente, certificateP12Path, certificatePassword);
      
      // Extraer estado de la respuesta
      const estadoMatch = respuesta.match(/<estado>(.*?)<\/estado>/);
      if (estadoMatch && estadoMatch[1]) {
        estadoMockSet = estadoMatch[1].trim();
      }
      
      // Si el estado en Mock SET es diferente, actualizar en BD
      if (estadoMockSet && estadoMockSet !== invoiceRecord.estadoSifen) {
        invoiceRecord.estadoSifen = estadoMockSet;
        await invoiceRecord.save();
        console.log(`🔄 Estado actualizado para CDC ${cdc}: ${invoiceRecord.estadoSifen}`);
      }
    } catch (error) {
      // Si no se puede consultar al Mock SET, usar el estado local
      console.log('⚠️ No se pudo consultar el estado al Mock SET, usando estado local');
    }

    res.status(200).json({
      encontrado: true,
      cdc: cdc,
      estadoLocal: invoiceRecord.estadoSifen,
      estadoMockSet: estadoMockSet,
      estadoActualizado: estadoMockSet !== invoiceRecord.estadoSifen,
      datos: {
        correlativo: invoiceRecord.correlativo,
        codigoRetorno: invoiceRecord.codigoRetorno,
        mensajeRetorno: invoiceRecord.mensajeRetorno,
        fechaCreacion: invoiceRecord.fechaCreacion,
        fechaEnvio: invoiceRecord.fechaEnvio,
        fechaProceso: invoiceRecord.fechaProceso,
        total: invoiceRecord.total,
        cliente: invoiceRecord.cliente
      }
    });
  } catch (error) {
    console.error('Error al verificar estado:', error);
    res.status(500).json({ error: 'Error al verificar estado' });
  }
});

// Endpoint para limpiar/eliminar todas las facturas de la base de datos
app.delete('/api/invoices/clear', async (req, res) => {
  try {
    // Eliminar todos los documentos de la colección Invoice
    const result = await Invoice.deleteMany({});
    
    // Eliminar todos los registros de operaciones
    const logsResult = await OperationLog.deleteMany({});
    
    console.log(`🗑️ Base de datos limpiada: ${result.deletedCount} facturas, ${logsResult.deletedCount} registros eliminados`);
    
    res.status(200).json({
      success: true,
      message: 'Base de datos limpiada exitosamente',
      deletedCount: result.deletedCount,
      deletedLogs: logsResult.deletedCount
    });
  } catch (error) {
    console.error('Error al limpiar base de datos:', error);
    res.status(500).json({ 
      success: false,
      error: 'Error al limpiar la base de datos',
      message: error.message 
    });
  }
});

// Endpoint para eliminar una factura específica por ID
app.delete('/api/invoices/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await Invoice.findByIdAndDelete(id);
    
    if (!result) {
      return res.status(404).json({
        success: false,
        error: 'Factura no encontrada'
      });
    }
    
    // Eliminar también los logs asociados
    await OperationLog.deleteMany({ invoiceId: id });
    
    console.log(`🗑️ Factura eliminada: ${id}`);
    
    res.status(200).json({
      success: true,
      message: 'Factura eliminada exitosamente',
      deletedId: id
    });
  } catch (error) {
    console.error('Error al eliminar factura:', error);
    res.status(500).json({ 
      success: false,
      error: 'Error al eliminar la factura',
      message: error.message 
    });
  }
});

// Endpoint para consultar y actualizar el estado desde el Mock-SET
app.post('/api/invoices/:id/refresh-status', async (req, res) => {
  try {
    const { id } = req.params;
    
    console.log(`🔄 Consultando estado para factura ID: ${id}`);

    // Buscar la factura en la base de datos
    const invoiceRecord = await Invoice.findById(id);
    
    if (!invoiceRecord) {
      console.log(`❌ Factura no encontrada: ${id}`);
      return res.status(404).json({
        success: false,
        error: 'Factura no encontrada'
      });
    }
    
    if (!invoiceRecord.cdc) {
      console.log(`❌ Factura sin CDC: ${id}`);
      return res.status(400).json({
        success: false,
        error: 'La factura no tiene CDC asignado'
      });
    }
    
    console.log(`📋 CDC encontrado: ${invoiceRecord.cdc}, Estado actual: ${invoiceRecord.estadoSifen}`);
    
    // Consultar al Mock-SET para obtener el estado actual
    try {
      const idConsulta = crypto.randomBytes(16).toString('hex');
      const ambiente = "test";
      const certificateP12Path = path.join(__dirname, '../certificados', 'p12', 'certificado.p12');
      const certificatePassword = '123456';

      console.log('📤 Enviando consulta al Mock-SET...');

      const respuesta = await setApi.consulta(idConsulta, invoiceRecord.cdc, ambiente, certificateP12Path, certificatePassword);
      
      console.log('📥 Respuesta recibida del Mock-SET');
      console.log('Respuesta:', respuesta.substring(0, 500));
      
      // Extraer estado de la respuesta SOAP
      const estadoMatch = respuesta.match(/<estado>(.*?)<\/estado>/);
      const codigoRetornoMatch = respuesta.match(/<codigoRetorno>(.*?)<\/codigoRetorno>/);
      const mensajeRetornoMatch = respuesta.match(/<mensajeRetorno>(.*?)<\/mensajeRetorno>/);
      
      console.log('🔍 Extrayendo datos de la respuesta...');
      console.log('  estadoMatch:', estadoMatch);
      console.log('  codigoRetornoMatch:', codigoRetornoMatch);
      console.log('  mensajeRetornoMatch:', mensajeRetornoMatch);
      
      let nuevoEstado = invoiceRecord.estadoSifen;
      let codigoRetorno = invoiceRecord.codigoRetorno;
      let mensajeRetorno = invoiceRecord.mensajeRetorno;
      
      if (estadoMatch && estadoMatch[1]) {
        nuevoEstado = estadoMatch[1].trim();
        console.log('  Estado extraído del XML:', nuevoEstado);
      }
      
      if (codigoRetornoMatch && codigoRetornoMatch[1]) {
        codigoRetorno = codigoRetornoMatch[1].trim();
        console.log('  Código de retorno extraído:', codigoRetorno);
      }
      
      if (mensajeRetornoMatch && mensajeRetornoMatch[1]) {
        mensajeRetorno = mensajeRetornoMatch[1].trim();
        console.log('  Mensaje extraído:', mensajeRetorno);
      }
      
      // Determinar el estado basado en el código de retorno
      const estadoDeterminado = determinarEstadoSegunCodigoRetorno(codigoRetorno, null, mensajeRetorno);
      console.log('  Estado determinado:', estadoDeterminado, '(desde código:', codigoRetorno + ')');
      
      // Usar el estado determinado si es más específico que el extraído directamente
      if (estadoDeterminado !== 'enviado') {
        nuevoEstado = estadoDeterminado;
      }
      
      console.log('  Nuevo estado final:', nuevoEstado);
      
      // Verificar si el estado cambió
      const estadoCambio = nuevoEstado !== invoiceRecord.estadoSifen;
      
      // Actualizar en la base de datos si hubo cambios
      if (estadoCambio) {
        invoiceRecord.estadoSifen = nuevoEstado;
        invoiceRecord.codigoRetorno = codigoRetorno;
        invoiceRecord.mensajeRetorno = mensajeRetorno;
        
        // Registrar el cambio de estado
        const log = new OperationLog({
          invoiceId: id,
          tipoOperacion: 'actualizacion_estado',
          descripcion: `Estado actualizado de ${invoiceRecord.estadoSifen} a ${nuevoEstado}`,
          estadoAnterior: invoiceRecord.estadoSifen,
          estadoNuevo: nuevoEstado,
          fecha: new Date()
        });
        await log.save();
        
        await invoiceRecord.save();
        
        console.log(`✅ Estado actualizado para factura ${id}: ${invoiceRecord.estadoSifen} → ${nuevoEstado}`);
      } else {
        console.log(`ℹ️ Estado sin cambios: ${nuevoEstado}`);
      }
      
      res.status(200).json({
        success: true,
        message: estadoCambio ? 'Estado actualizado' : 'Estado sin cambios',
        estadoAnterior: invoiceRecord.estadoSifen,
        estadoActual: nuevoEstado,
        estadoCambio: estadoCambio,
        codigoRetorno: codigoRetorno,
        mensajeRetorno: mensajeRetorno
      });
      
    } catch (error) {
      console.error('❌ Error consultando al Mock-SET:', error);
      console.error('Stack trace:', error.stack);
      res.status(500).json({
        success: false,
        error: 'Error al consultar el estado en Mock-SET',
        message: error.message
      });
    }
  } catch (error) {
    console.error('❌ Error al actualizar estado:', error);
    res.status(500).json({ 
      success: false,
      error: 'Error al actualizar el estado',
      message: error.message 
    });
  }
});

// ========================================
// INICIO DEL SERVIDOR
// ========================================

// Iniciar el servidor
const PORT = process.env.PORT || 8081;

const iniciarServidor = async () => {
  await connectDB();

  app.listen(PORT, () => {
    console.log(`🚀 Servidor de facturación electrónica iniciado en http://localhost:${PORT}`);
    console.log(`📋 Endpoints disponibles:`);
    console.log(`   POST /get_einvoice - Genera factura (con cola asíncrona)`);
    console.log(`   GET  /get_einvoice - Información del servidor`);
    console.log(`   GET  /api/stats - Estadísticas del sistema`);
    console.log(`   GET  /api/invoices - Lista de facturas`);
    console.log(`   GET  /api/factura/estado/:id - Estado de factura (cola)`);
    console.log(`   GET  /api/queue/stats - Estadísticas de la cola`);
  });
};

// Si este archivo es ejecutado directamente, iniciar el servidor
if (require.main === module) {
  iniciarServidor();
}

module.exports = app;
