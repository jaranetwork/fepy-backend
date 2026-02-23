const express = require('express');
const router = express.Router();
const Invoice = require('../models/Invoice');
// No requerir autenticación para stats (usado para verificar conexión)
// const { verificarToken } = require('../middleware/auth');

// Ruta pública para verificar estado del servidor
router.get('/', async (req, res) => {
  try {
    const totalFacturas = await Invoice.countDocuments();
    const facturasPorEstado = await Invoice.aggregate([
      { $group: { _id: '$estadoSifen', count: { $sum: 1 } } }
    ]);
    
    const facturasProcesando = await Invoice.countDocuments({ estadoSifen: 'procesando' });
    const facturasEnviadas = await Invoice.countDocuments({ estadoSifen: 'enviado' });
    const facturasError = await Invoice.countDocuments({ estadoSifen: 'error' });
    const facturasRechazadas = await Invoice.countDocuments({ estadoSifen: 'rechazado' });
    const facturasAceptadas = await Invoice.countDocuments({ estadoSifen: 'aceptado' });

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

    // Tendencias de facturación por día (últimos 7 días)
    const hace7Dias = new Date();
    hace7Dias.setDate(hace7Dias.getDate() - 7);
    
    const tendenciasPorDia = await Invoice.aggregate([
      {
        $match: {
          fechaCreacion: { $gte: hace7Dias }
        }
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$fechaCreacion' }
          },
          count: { $sum: 1 },
          total: { $sum: '$total' }
        }
      },
      {
        $sort: { _id: 1 }
      }
    ]);

    res.json({
      totalFacturas,
      facturasPorEstado,
      facturasProcesando,
      facturasEnviadas,
      facturasError,
      facturasRechazadas,
      facturasAceptadas,
      facturasHoy,
      ultimasFacturas,
      tendenciasPorDia,
      fechaUltimaConsulta: new Date()
    });
  } catch (error) {
    console.error('Error en /api/stats:', error);
    res.json({
      totalFacturas: 0,
      facturasPorEstado: [],
      facturasProcesando: 0,
      facturasEnviadas: 0,
      facturasError: 0,
      facturasRechazadas: 0,
      facturasAceptadas: 0,
      facturasHoy: 0,
      ultimasFacturas: [],
      fechaUltimaConsulta: new Date()
    });
  }
});

module.exports = router;
