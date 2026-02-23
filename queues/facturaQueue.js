/**
 * Colas de trabajo para Facturación Electrónica
 * Usa Bull (Redis) para procesamiento asíncrono
 */

const Queue = require('bull');
const path = require('path');

// Configuración de Redis
const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  maxRetriesPerRequest: null,  // Importante para Bull
  retryStrategy: (times) => {
    if (times > 3) return null;  // Dejar de reintentar después de 3 intentos
    return Math.min(times * 200, 2000);  // Delay exponencial
  }
};

// Cola principal de facturación
const facturaQueue = new Queue('facturacion', {
  redis: redisConfig,
  defaultJobOptions: {
    attempts: 3,  // Reintentos si falla
    backoff: {
      type: 'exponential',
      delay: 1000  // 1s, 2s, 4s entre reintentos
    },
    removeOnComplete: {
      count: 100  // Mantener últimos 100 jobs completados
    },
    removeOnFail: {
      count: 10000  // Mantener últimos 10000 jobs fallidos para debugging
    },
    timeout: 300000  // 5 minutos timeout por job
  }
});

// Cola de generación de KUDE (PDF)
const kudeQueue = new Queue('kude', {
  redis: redisConfig,
  defaultJobOptions: {
    attempts: 2,
    backoff: {
      type: 'fixed',
      delay: 2000
    },
    removeOnComplete: 50,
    removeOnFail: 1000,
    timeout: 120000  // 2 minutos
  }
});

// ========================================
// EVENTOS DE MONITOREO
// ========================================

// Progreso del job
facturaQueue.on('progress', (job, progress) => {
  console.log(`📊 [FACTURA] Job ${job.id}: ${progress}% completado`);
});

// Job completado exitosamente
facturaQueue.on('completed', (job, result) => {
  console.log(`✅ [FACTURA] Job ${job.id} completado - CDC: ${result?.cdc || 'N/A'}`);
});

// Job fallido
facturaQueue.on('failed', (job, err) => {
  console.error(`❌ [FACTURA] Job ${job.id} falló: ${err.message}`);
  console.error(`   Datos: RUC=${job.data?.datosFactura?.ruc}, Numero=${job.data?.datosFactura?.numero}`);
});

// Job en espera
facturaQueue.on('waiting', (jobId) => {
  console.log(`⏳ [FACTURA] Job ${jobId} en espera`);
});

// Job activo (procesando)
facturaQueue.on('active', (job) => {
  console.log(`🔄 [FACTURA] Job ${job.id} procesando (intento ${job.attemptsMade + 1})`);
});

// Job estancado (stalled)
facturaQueue.on('stalled', (jobId) => {
  console.warn(`⚠️ [FACTURA] Job ${jobId} estancado - se reintentará`);
});

// Error en la cola
facturaQueue.on('error', (err) => {
  console.error(`💥 [FACTURA] Error en la cola: ${err.message}`);
});

// Eventos de KUDE
kudeQueue.on('completed', (job, result) => {
  console.log(`✅ [KUDE] Job ${job.id} completado`);
});

kudeQueue.on('failed', (job, err) => {
  console.error(`❌ [KUDE] Job ${job.id} falló: ${err.message}`);
});

// ========================================
// FUNCIONES UTILITARIAS
// ========================================

/**
 * Obtener estadísticas de la cola
 */
async function getQueueStats() {
  const [facturacionWaiting, facturacionActive, facturacionCompleted, facturacionFailed] = await Promise.all([
    facturaQueue.getWaitingCount(),
    facturaQueue.getActiveCount(),
    facturaQueue.getCompletedCount(),
    facturaQueue.getFailedCount()
  ]);

  const [kudeWaiting, kudeActive, kudeCompleted, kudeFailed] = await Promise.all([
    kudeQueue.getWaitingCount(),
    kudeQueue.getActiveCount(),
    kudeQueue.getCompletedCount(),
    kudeQueue.getFailedCount()
  ]);

  return {
    facturacion: {
      waiting: facturacionWaiting,
      active: facturacionActive,
      completed: facturacionCompleted,
      failed: facturacionFailed
    },
    kude: {
      waiting: kudeWaiting,
      active: kudeActive,
      completed: kudeCompleted,
      failed: kudeFailed
    }
  };
}

/**
 * Limpiar cola de completados
 */
async function cleanCompletedJobs(queue, count = 100) {
  const jobs = await queue.getCompleted();
  if (jobs.length > count) {
    const toRemove = jobs.slice(0, jobs.length - count);
    await Promise.all(toRemove.map(job => job.remove()));
    return toRemove.length;
  }
  return 0;
}

/**
 * Reintentar jobs fallidos
 */
async function retryFailedJobs(queue, limit = 10) {
  const jobs = await queue.getFailed();
  const toRetry = jobs.slice(0, limit);
  
  for (const job of toRetry) {
    await job.retry();
    console.log(`🔄 Job ${job.id} reencolado para reintento`);
  }
  
  return toRetry.length;
}

// ========================================
// EXPORTS
// ========================================

module.exports = {
  facturaQueue,
  kudeQueue,
  getQueueStats,
  cleanCompletedJobs,
  retryFailedJobs,
  redisConfig
};
