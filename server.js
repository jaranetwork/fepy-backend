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
// NOTA: Esta línea fue reemplazada por el wrapper setapi-wrapper.js
// const setApi = require('../mock-set/setapi-mock').default;

// Configurar el mock (opcional, solo para debugging)
// if (process.env.MOCK_DEBUG === 'true') {
//   setApi.configure({ mockUrl: process.env.MOCK_SET_URL || 'http://localhost:8082', debug: true });
// }

// Importar modelos
const Invoice = require('./models/Invoice');
const OperationLog = require('./models/OperationLog');

// Importar utilitarios SIFEN
const { determinarEstadoSegunCodigo, determinarEstadoVisual, extraerEstadoDocumento } = require('./utils/estadoSifen');

// Importar wrapper de SET API (soporta Mock y Producción)
const setApi = require('./services/setapi-wrapper');

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

// Rutas de empresas y facturación
const empresaRoutes = require('./routes/empresas');
const facturarRoutes = require('./routes/facturar');

// Usar rutas
app.use('/api/stats', statsRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/empresas', empresaRoutes);
app.use('/api/facturar', facturarRoutes);

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

// Endpoint para consultar una factura por CDC (consulta en SIFEN a través del backend)
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

    // Si no está en BD local, consultar a SIFEN
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

    // Consultar a SIFEN a través del backend
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

// ENDPOINT: JOBS RECIENTES DE LA COLA
// ========================================
app.get('/api/queue/jobs', async (req, res) => {
  try {
    const { limit = 20 } = req.query;
    const { getRecentJobs } = require('./queues/facturaQueue');
    const jobs = await getRecentJobs(parseInt(limit));

    res.json({
      success: true,
      data: jobs
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ENDPOINT: LIMPIAR JOBS COMPLETADOS
// ========================================
app.post('/api/queue/clear', async (req, res) => {
  try {
    const { queue = 'facturacion', keep = 0 } = req.body;
    const { facturaQueue, kudeQueue, cleanCompletedJobs } = require('./queues/facturaQueue');

    const targetQueue = queue === 'kude' ? kudeQueue : facturaQueue;
    const removed = await cleanCompletedJobs(targetQueue, keep);

    res.json({
      success: true,
      message: `Se eliminaron ${removed} jobs completados de la cola ${queue}`,
      data: { removed, queue, keep }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ENDPOINT: LIMPIAR JOBS FALLIDOS
// ========================================
app.post('/api/queue/clear-failed', async (req, res) => {
  try {
    const { queue = 'facturacion' } = req.body;
    const { facturaQueue, kudeQueue, cleanFailedJobs } = require('./queues/facturaQueue');

    const targetQueue = queue === 'kude' ? kudeQueue : facturaQueue;
    const removed = await cleanFailedJobs(targetQueue);

    res.json({
      success: true,
      message: `Se eliminaron ${removed} jobs fallidos de la cola ${queue}`,
      data: { removed, queue }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ENDPOINT: LIMPIAR TODOS LOS JOBS
// ========================================
app.post('/api/queue/clear-all', async (req, res) => {
  try {
    const { queue = 'facturacion' } = req.body;
    const { facturaQueue, kudeQueue, cleanAllJobs } = require('./queues/facturaQueue');

    const targetQueue = queue === 'kude' ? kudeQueue : facturaQueue;
    const removed = await cleanAllJobs(targetQueue);

    res.json({
      success: true,
      message: `Se eliminaron ${removed} jobs de la cola ${queue}`,
      data: { removed, queue }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ENDPOINT: LIMPIAR JOBS COMPLETADOS (alias)
// ========================================
app.post('/api/queue/clear-completed', async (req, res) => {
  try {
    const { queue = 'facturacion', keep = 0 } = req.body;
    const { facturaQueue, kudeQueue, cleanCompletedJobs } = require('./queues/facturaQueue');

    const targetQueue = queue === 'kude' ? kudeQueue : facturaQueue;
    const removed = await cleanCompletedJobs(targetQueue, keep);

    res.json({
      success: true,
      message: `Se eliminaron ${removed} jobs completados de la cola ${queue}`,
      data: { removed, queue, keep }
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

// Endpoint para limpiar registros de logs
app.delete('/api/logs/clear', async (req, res) => {
  try {
    const { tipo } = req.query; // 'all', 'error', 'success', 'warning'
    
    let filtro = {};
    if (tipo && tipo !== 'all') {
      filtro.estado = tipo;
    }
    
    const result = await OperationLog.deleteMany(filtro);
    
    console.log(`🗑️ Logs eliminados: ${result.deletedCount} registros (filtro: ${tipo || 'todos'})`);
    
    res.status(200).json({
      success: true,
      message: `Se eliminaron ${result.deletedCount} registros de logs`,
      deletedCount: result.deletedCount
    });
  } catch (error) {
    console.error('Error al limpiar logs:', error);
    res.status(500).json({ 
      success: false,
      error: 'Error al limpiar logs',
      message: error.message 
    });
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

    // Verificar si el estado ha cambiado consultando a la SET
    let estadoActual = invoiceRecord.estadoSifen;
    let estadoSET = null;

    try {
      // Obtener configuración de la empresa
      const Empresa = require('./models/Empresa');
      const empresa = await Empresa.findById(invoiceRecord.empresaId);
      
      if (!empresa) {
        console.log('⚠️ No se encontró la empresa, usando configuración por defecto');
      }

      const idConsulta = crypto.randomBytes(16).toString('hex');
      const ambiente = empresa?.configuracionSifen?.modo || 'test';
      
      // Obtener ruta y contraseña del certificado de la empresa
      let certificateP12Path = path.join(__dirname, '../certificados', 'p12', 'certificado.p12');
      let certificatePassword = '123456';
      
      if (empresa?.certificado?.nombreArchivo) {
        const certificadoService = require('./services/certificadoService');
        certificateP12Path = path.join(__dirname, '../certificados', 'p12', empresa.certificado.nombreArchivo);
        certificatePassword = certificadoService.descifrarContrasena(empresa.certificado.contrasena);
        console.log(`🔑 Usando certificado de la empresa: ${empresa.certificado.nombreArchivo}`);
      } else {
        console.log('⚠️ Empresa no tiene certificado configurado, usando certificado por defecto');
      }

      const respuesta = await setApi.consulta(idConsulta, cdc, ambiente, certificateP12Path, certificatePassword);

      // Extraer campos de la respuesta SOAP (soporta formatos SIFEN v150 con namespace y genéricos)
      const codigoRetornoMatch =
        respuesta.match(/<ns2:dCodRes>(.*?)<\/ns2:dCodRes>/) ||
        respuesta.match(/<dCodRes>(.*?)<\/dCodRes>/) ||
        respuesta.match(/<codigoRetorno>(.*?)<\/codigoRetorno>/);

      let codigoRetorno = null;
      let estadoSET = null;

      if (codigoRetornoMatch && codigoRetornoMatch[1]) {
        codigoRetorno = codigoRetornoMatch[1].trim();
      }

      // Usar la función utilitaria para extraer el estado del documento
      estadoSET = extraerEstadoDocumento(respuesta);

      console.log(`📥 Consulta SET - CDC: ${cdc}, dCodRes: ${codigoRetorno}, estado: ${estadoSET}`);

      // Si hay respuesta de la SET, actualizar estado y estadoVisual
      if (codigoRetorno && estadoSET) {
        let nuevoEstadoSifen = invoiceRecord.estadoSifen;
        let nuevoEstadoVisual = invoiceRecord.estadoVisual;

        // Determinar estado según respuesta de consulta
        if (codigoRetorno === '0421') {
          // CDC encontrado - el estado real está en <estado>
          if (estadoSET === 'Aprobado' || estadoSET === 'aprobado') {
            nuevoEstadoSifen = 'aceptado';
            nuevoEstadoVisual = 'aceptado';
          } else if (estadoSET === 'Rechazado' || estadoSET === 'rechazado') {
            nuevoEstadoSifen = 'rechazado';
            nuevoEstadoVisual = 'rechazado';
          } else if (estadoSET === 'Aprobado con observación' || estadoSET === 'observado') {
            // Transmisión extemporánea (código 1005)
            nuevoEstadoSifen = 'observado';
            nuevoEstadoVisual = 'observado';
          } else {
            // Pendiente
            nuevoEstadoSifen = 'procesando';
            nuevoEstadoVisual = 'observado';
          }
        } else if (codigoRetorno === '0420') {
          // CDC inexistente
          nuevoEstadoSifen = 'rechazado';
          nuevoEstadoVisual = 'rechazado';
        } else if (codigoRetorno === '1005') {
          // Transmisión extemporánea - ÚNICO CASO donde estado = 'observado'
          nuevoEstadoSifen = 'observado';
          nuevoEstadoVisual = 'observado';
        }

        // Actualizar si hubo cambios
        if (nuevoEstadoSifen !== invoiceRecord.estadoSifen || nuevoEstadoVisual !== invoiceRecord.estadoVisual) {
          invoiceRecord.estadoSifen = nuevoEstadoSifen;
          invoiceRecord.estadoVisual = nuevoEstadoVisual;
          invoiceRecord.codigoRetorno = codigoRetorno;
          await invoiceRecord.save();
          console.log(`🔄 Estado actualizado para CDC ${cdc}: ${nuevoEstadoSifen} / ${nuevoEstadoVisual}`);
        }
      }
    } catch (error) {
      // Si no se puede consultar a la SET, usar el estado local
      console.log('⚠️ No se pudo consultar el estado a la SET, usando estado local');
    }

    res.status(200).json({
      encontrado: true,
      cdc: cdc,
      estadoLocal: invoiceRecord.estadoSifen,
      estadoSET: estadoSET,
      estadoActualizado: estadoSET !== invoiceRecord.estadoSifen,
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

// Endpoint para consultar y actualizar el estado desde la SET
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

    // Consultar a la SET para obtener el estado actual
    try {
      // Obtener configuración de la empresa
      const Empresa = require('./models/Empresa');
      const empresa = await Empresa.findById(invoiceRecord.empresaId);
      
      if (!empresa) {
        console.log('⚠️ No se encontró la empresa, usando configuración por defecto');
      }

      const idConsulta = crypto.randomBytes(16).toString('hex');
      const ambiente = empresa?.configuracionSifen?.modo || 'test';
      
      // Obtener ruta y contraseña del certificado de la empresa
      let certificateP12Path = path.join(__dirname, '../certificados', 'p12', 'certificado.p12');
      let certificatePassword = '123456';
      
      if (empresa?.certificado?.nombreArchivo) {
        const certificadoService = require('./services/certificadoService');
        certificateP12Path = path.join(__dirname, '../certificados', 'p12', empresa.certificado.nombreArchivo);
        certificatePassword = certificadoService.descifrarContrasena(empresa.certificado.contrasena);
        console.log(`🔑 Usando certificado de la empresa: ${empresa.certificado.nombreArchivo}`);
      } else {
        console.log('⚠️ Empresa no tiene certificado configurado, usando certificado por defecto');
      }

      console.log('📤 Enviando consulta a la SET...');

      const respuesta = await setApi.consulta(idConsulta, invoiceRecord.cdc, ambiente, certificateP12Path, certificatePassword);

      console.log('📥 Respuesta recibida de la SET');
      console.log('Respuesta:', respuesta.substring(0, 500));

      // Extraer campos de la respuesta SOAP según Manual Técnico v150
      // Estructura: <rProtDe><dCodRes>...</dCodRes><dEstRes>...</dEstRes><dMsgRes>...</dMsgRes>...</rProtDe>
      // También soportamos formatos con namespace ns2: y formatos genéricos
      const codigoRetornoMatch =
        respuesta.match(/<ns2:dCodRes>(.*?)<\/ns2:dCodRes>/) ||
        respuesta.match(/<dCodRes>(.*?)<\/dCodRes>/) ||
        respuesta.match(/<codigoRetorno>(.*?)<\/codigoRetorno>/);

      const estadoRetornoMatch =
        respuesta.match(/<ns2:estado>(.*?)<\/ns2:estado>/) ||  // Primero buscar <estado> para consultas
        respuesta.match(/<estado>(.*?)<\/estado>/) ||
        respuesta.match(/<ns2:dEstRes>(.*?)<\/ns2:dEstRes>/) ||
        respuesta.match(/<dEstRes>(.*?)<\/dEstRes>/) ||
        respuesta.match(/<estadoResultado>(.*?)<\/estadoResultado>/);

      const mensajeRetornoMatch =
        respuesta.match(/<ns2:dMsgRes>(.*?)<\/ns2:dMsgRes>/) ||
        respuesta.match(/<dMsgRes>(.*?)<\/dMsgRes>/) ||
        respuesta.match(/<mensajeRetorno>(.*?)<\/mensajeRetorno>/);

      const fechaProcesoMatch =
        respuesta.match(/<ns2:dFecProc>(.*?)<\/ns2:dFecProc>/) ||
        respuesta.match(/<dFecProc>(.*?)<\/dFecProc>/) ||
        respuesta.match(/<fechaProceso>(.*?)<\/fechaProceso>/);

      const digestValueMatch =
        respuesta.match(/<ns2:dDigVal>(.*?)<\/ns2:dDigVal>/) ||
        respuesta.match(/<dDigVal>(.*?)<\/dDigVal>/) ||
        respuesta.match(/<digestValue>(.*?)<\/digestValue>/);

      console.log('🔍 Extrayendo datos de la respuesta...');
      console.log('  codigoRetornoMatch:', codigoRetornoMatch);
      console.log('  estadoRetornoMatch:', estadoRetornoMatch);
      console.log('  mensajeRetornoMatch:', mensajeRetornoMatch);
      console.log('  Respuesta SOAP (primeros 800 chars):', respuesta.substring(0, 800));

      let codigoRetorno = invoiceRecord.codigoRetorno;
      let estadoRetorno = invoiceRecord.respuestaSifen?.estado;
      let mensajeRetorno = invoiceRecord.mensajeRetorno;
      let fechaProceso = invoiceRecord.fechaProceso;
      let digestValueResp = invoiceRecord.digestValue;

      if (codigoRetornoMatch && codigoRetornoMatch[1]) {
        codigoRetorno = codigoRetornoMatch[1].trim();
        console.log('  Código de retorno extraído:', codigoRetorno);
      }

      if (estadoRetornoMatch && estadoRetornoMatch[1]) {
        estadoRetorno = estadoRetornoMatch[1].trim();
        console.log('  Estado de retorno extraído:', estadoRetorno);
      }

      if (mensajeRetornoMatch && mensajeRetornoMatch[1]) {
        mensajeRetorno = mensajeRetornoMatch[1].trim();
        console.log('  Mensaje extraído:', mensajeRetorno);
      }

      if (fechaProcesoMatch && fechaProcesoMatch[1]) {
        fechaProceso = fechaProcesoMatch[1].trim();
        console.log('  Fecha de proceso extraída:', fechaProceso);
      }

      if (digestValueMatch && digestValueMatch[1]) {
        digestValueResp = digestValueMatch[1].trim();
        console.log('  DigestValue extraído:', digestValueResp);
      }

      // Determinar estado visual según código de retorno según Manual Técnico v150
      //
      // Para RECEPCIÓN (siRecepDE) - Sección 9.1.3:
      // - 0260 = Autorización satisfactoria (Aprobado) 🟢
      // - 1005 = Transmisión extemporánea (Observado) 🟠
      // - 1000-1004 = Errores de validación (Rechazado) 🔴
      //
      // Para CONSULTA (siConsDE) - Sección 12.3.4.3:
      // - 0420 = CDC inexistente (Error - no encontrado en SET) 🔴
      // - 0421 = CDC encontrado (Éxito de consulta) - estado real depende del documento 🟢
      // - 0422 = CDC encontrado (alternativo)
      //
      // NOTA: El campo <estado> NO es parte del schema oficial (Schema XML 10).
      // Para obtener el estado real cuando dCodRes=0421, debemos consultar el documento
      // en el mock-set vía REST API.
      //
      // NOTA: El código 0000 NO es oficial. Se usaba anteriormente para "En procesamiento".
      let estadoVisual = 'rechazado';
      let estadoSifen = 'rechazado';

      if (codigoRetorno === '0260') {
        // Recepción: Autorización satisfactoria (DTE aprobado)
        estadoVisual = 'aceptado';
        estadoSifen = 'aceptado';
        console.log('  ✅ Código 0260: Autorización satisfactoria');
      } else if (codigoRetorno === '1005') {
        // Recepción: Transmisión extemporánea - ÚNICO CASO donde estado = 'observado'
        estadoVisual = 'observado';
        estadoSifen = 'observado';
        console.log('  ⚠️ Código 1005: Transmisión extemporánea');
      } else if (['1000', '1001', '1002', '1003', '1004'].includes(codigoRetorno)) {
        // Recepción: Errores de validación - Rechazado
        estadoVisual = 'rechazado';
        estadoSifen = 'rechazado';
        console.log('  ❌ Código', codigoRetorno, ': Error de validación - Rechazado');
      } else if (codigoRetorno === '0420') {
        // Consulta: CDC inexistente - La factura no está en la SET
        estadoVisual = 'error';
        estadoSifen = 'error';
        console.log('  ❌ Código 0420: CDC inexistente - Factura no encontrada en SET');
      } else if (codigoRetorno === '0421') {
        // Consulta: RUC Certificado sin permiso - Error de autenticación
        estadoVisual = 'rechazado';
        estadoSifen = 'rechazado';
        console.log('  ❌ Código 0421: RUC Certificado sin permiso para consultar');
      } else if (codigoRetorno === '0422') {
        // Consulta: CDC encontrado - Documento APROBADO
        estadoVisual = 'aceptado';
        estadoSifen = 'aceptado';
        console.log('  ✅ Código 0422: CDC encontrado - Documento APROBADO');
      }

      console.log('  Estado visual:', estadoVisual, '(desde código:', codigoRetorno + ')');
      console.log('  Estado SIFEN:', estadoSifen);
      
      // Verificar si el estado cambió
      const estadoCambio = estadoSifen !== invoiceRecord.estadoSifen;

      // Actualizar en la base de datos si hubo cambios o si es la primera respuesta
      if (estadoCambio || !invoiceRecord.respuestaSifen?.codigo) {
        invoiceRecord.estadoSifen = estadoSifen;
        invoiceRecord.estadoVisual = estadoVisual;
        invoiceRecord.codigoRetorno = codigoRetorno;
        invoiceRecord.mensajeRetorno = mensajeRetorno;
        invoiceRecord.fechaProceso = fechaProceso;
        
        // Guardar respuesta completa SIFEN v150
        invoiceRecord.respuestaSifen = {
          codigo: codigoRetorno,
          estado: estadoRetorno,
          mensaje: mensajeRetorno,
          fechaProceso: fechaProceso,
          digestValue: digestValueResp
        };

        // Determinar el tipo de operación y estado del log según el resultado
        let tipoOperacion = 'actualizacion_estado';
        let logEstado = 'success';
        let descripcion = `Estado actualizado a ${estadoSifen}`;
        
        // Si el estado es rechazado o inexistente, registrar como error
        if (estadoVisual === 'rechazado') {
          tipoOperacion = 'error_respuesta_set';
          logEstado = 'error';
          descripcion = `Factura rechazada por SET: ${mensajeRetorno || codigoRetorno}`;
          
          if (codigoRetorno === '0420') {
            descripcion = `CDC inexistente en SET - La factura no fue encontrada en la base de datos de la SET`;
          }
        } else if (estadoVisual === 'observado') {
          tipoOperacion = 'actualizacion_estado';
          logEstado = 'warning';
          descripcion = `Factura aceptada con observación: ${mensajeRetorno || 'Transmisión extemporánea'}`;
        } else if (estadoVisual === 'aceptado') {
          descripcion = `Factura aceptada por SET: ${mensajeRetorno || 'Autorización satisfactoria'}`;
        }

        // Registrar el cambio de estado
        const log = new OperationLog({
          invoiceId: id,
          tipoOperacion: tipoOperacion,
          descripcion: descripcion,
          estadoAnterior: invoiceRecord.estadoSifen,
          estadoNuevo: estadoSifen,
          estado: logEstado,
          fecha: new Date(),
          detalle: {
            cdc: invoiceRecord.cdc,
            correlativo: invoiceRecord.correlativo,
            codigoRetorno: codigoRetorno,
            estadoRetorno: estadoRetorno,
            mensajeRetorno: mensajeRetorno,
            estadoVisual: estadoVisual,
            huboCambio: estadoCambio
          }
        });
        await log.save();

        await invoiceRecord.save();

        if (logEstado === 'error') {
          console.log(`❌ Factura rechazada para factura ${id}: ${descripcion}`);
        } else if (logEstado === 'warning') {
          console.log(`⚠️ Factura observada para factura ${id}: ${descripcion}`);
        } else {
          console.log(`✅ Estado actualizado para factura ${id}: ${invoiceRecord.estadoSifen} → ${estadoSifen}`);
        }
      } else {
        console.log(`ℹ️ Estado sin cambios: ${estadoSifen}`);

        // Registrar la consulta de estado aunque no haya cambios
        const log = new OperationLog({
          invoiceId: id,
          tipoOperacion: 'consulta_estado',
          descripcion: `Consulta de estado realizada - Estado actual: ${estadoSifen}`,
          estado: 'success',
          fecha: new Date(),
          detalle: {
            cdc: invoiceRecord.cdc,
            correlativo: invoiceRecord.correlativo,
            codigoRetorno: codigoRetorno,
            estadoRetorno: estadoRetorno,
            mensajeRetorno: mensajeRetorno,
            estadoVisual: estadoVisual,
            huboCambio: false
          }
        });
        await log.save();
      }

      res.status(200).json({
        success: true,
        message: estadoCambio ? 'Estado actualizado' : 'Estado sin cambios',
        estadoAnterior: invoiceRecord.estadoSifen,
        estadoActual: estadoSifen,
        estadoVisual: estadoVisual,
        estadoCambio: estadoCambio,
        codigoRetorno: codigoRetorno,
        mensajeRetorno: mensajeRetorno,
        respuestaSifen: invoiceRecord.respuestaSifen
      });
      
    } catch (error) {
      console.error('❌ Error consultando a la SET:', error);
      console.error('Stack trace:', error.stack);
      
      // Registrar el error en los logs de operación
      const log = new OperationLog({
        invoiceId: id,
        tipoOperacion: 'error_consulta_estado',
        descripcion: `Error al consultar estado en SET: ${error.message}`,
        estado: 'error',
        fecha: new Date(),
        detalle: {
          error: error.message,
          stack: error.stack
        }
      });
      await log.save();
      
      // Actualizar el estado de la factura a error si no estaba ya en error
      if (invoiceRecord.estadoSifen !== 'error') {
        invoiceRecord.estadoSifen = 'error';
        await invoiceRecord.save();
      }
      
      res.status(500).json({
        success: false,
        error: 'Error al consultar el estado en SET',
        message: error.message,
        estadoActual: 'error'
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
    console.log(`   POST /api/facturar/crear - Genera factura electrónica (con cola asíncrona)`);
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
