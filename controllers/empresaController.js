/**
 * Controller para gestión de empresas
 * CRUD completo para empresas con sus certificados digitales
 */

const Empresa = require('../models/Empresa');
const certificadoService = require('../services/certificadoService');
const Invoice = require('../models/Invoice');

/**
 * Listar todas las empresas del usuario autenticado
 * GET /api/empresas
 */
exports.listar = async (req, res) => {
  try {
    const empresas = await Empresa.find({ usuarioId: req.usuario._id })
      .select('-certificado.contrasena')
      .sort({ nombreFantasia: 1 });
    
    // Agregar información adicional
    const empresasConInfo = empresas.map(empresa => {
      const infoCertificado = certificadoService.obtenerInfoCertificado(empresa.ruc);
      return {
        ...empresa.toObject(),
        certificadoEnFileSystem: infoCertificado?.existe || false
      };
    });
    
    res.json({
      success: true,
      data: empresasConInfo
    });
  } catch (error) {
    console.error('❌ Error listando empresas:', error);
    res.status(500).json({
      success: false,
      error: 'Error al listar empresas',
      message: error.message
    });
  }
};

/**
 * Obtener detalles de una empresa específica
 * GET /api/empresas/:id
 */
exports.obtener = async (req, res) => {
  try {
    const { id } = req.params;
    
    const empresa = await Empresa.findOne({
      _id: id,
      usuarioId: req.usuario._id
    }).select('-certificado.contrasena');
    
    if (!empresa) {
      return res.status(404).json({
        success: false,
        error: 'Empresa no encontrada'
      });
    }
    
    // Agregar información del certificado
    const infoCertificado = certificadoService.obtenerInfoCertificado(empresa.ruc);
    
    res.json({
      success: true,
      data: {
        ...empresa.toObject(),
        certificadoEnFileSystem: infoCertificado?.existe || false
      }
    });
  } catch (error) {
    console.error('❌ Error obteniendo empresa:', error);
    res.status(500).json({
      success: false,
      error: 'Error al obtener empresa',
      message: error.message
    });
  }
};

/**
 * Crear una nueva empresa
 * POST /api/empresas
 */
exports.crear = async (req, res) => {
  try {
    const {
      ruc,
      nombreFantasia,
      razonSocial,
      configuracionSifen,
      direccion,
      telefono,
      email
    } = req.body;

    // Validar campos requeridos
    if (!ruc || !nombreFantasia || !razonSocial) {
      return res.status(400).json({
        success: false,
        error: 'RUC, nombre de fantasía y razón social son requeridos'
      });
    }

    // Limpiar RUC (eliminar guiones y otros caracteres no numéricos)
    const rucLimpio = ruc.replace(/[^0-9]/g, '');

    // Verificar RUC único
    const existe = await Empresa.findOne({ ruc: rucLimpio });
    if (existe) {
      return res.status(400).json({
        success: false,
        error: 'El RUC ya está registrado'
      });
    }

    // Crear empresa
    const empresa = new Empresa({
      ruc: rucLimpio,
      nombreFantasia,
      razonSocial,
      configuracionSifen,
      direccion,
      telefono,
      email,
      usuarioId: req.usuario._id
    });

    await empresa.save();

    console.log(`✅ Empresa creada: ${nombreFantasia} (RUC: ${rucLimpio})`);

    res.status(201).json({
      success: true,
      message: 'Empresa creada exitosamente',
      data: empresa
    });
  } catch (error) {
    console.error('❌ Error creando empresa:', error);
    res.status(500).json({
      success: false,
      error: 'Error al crear empresa',
      message: error.message
    });
  }
};

/**
 * Actualizar empresa existente
 * PUT /api/empresas/:id
 */
exports.actualizar = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      nombreFantasia,
      razonSocial,
      configuracionSifen,
      direccion,
      telefono,
      email,
      activo
    } = req.body;

    const empresa = await Empresa.findOne({
      _id: id,
      usuarioId: req.usuario._id
    });

    if (!empresa) {
      return res.status(404).json({
        success: false,
        error: 'Empresa no encontrada'
      });
    }

    // Actualizar campos
    if (nombreFantasia) empresa.nombreFantasia = nombreFantasia;
    if (razonSocial) empresa.razonSocial = razonSocial;
    if (configuracionSifen) {
      // Validar CSC si se proporciona (debe ser 32 caracteres hexadecimales)
      if (configuracionSifen.csc) {
        const cscLimpio = configuracionSifen.csc.trim();
        if (!/^[0-9A-F]{32}$/i.test(cscLimpio)) {
          return res.status(400).json({
            success: false,
            error: 'CSC inválido. Debe ser 32 caracteres hexadecimales'
          });
        }
        configuracionSifen.csc = cscLimpio.toUpperCase();
      }
      // Validar timbrado si se proporciona (debe ser 8 dígitos)
      if (configuracionSifen.timbrado) {
        if (!/^\d{8}$/.test(configuracionSifen.timbrado)) {
          return res.status(400).json({
            success: false,
            error: 'Timbrado inválido. Debe ser 8 dígitos'
          });
        }
      }
      // Validar idCSC si se proporciona (1-4 dígitos)
      if (configuracionSifen.idCSC) {
        if (!/^\d{1,4}$/.test(configuracionSifen.idCSC)) {
          return res.status(400).json({
            success: false,
            error: 'ID CSC inválido. Debe ser 1-4 dígitos'
          });
        }
      }
      // Validar modo si se proporciona
      if (configuracionSifen.modo && !['test', 'produccion'].includes(configuracionSifen.modo)) {
        return res.status(400).json({
          success: false,
          error: 'Modo inválido. Debe ser "test" o "produccion"'
        });
      }
      // Actualizar configuración SIFEN manteniendo valores existentes
      empresa.configuracionSifen = {
        ...empresa.configuracionSifen,
        ...configuracionSifen
      };
    }
    if (direccion !== undefined) empresa.direccion = direccion;
    if (telefono !== undefined) empresa.telefono = telefono;
    if (email !== undefined) empresa.email = email;
    if (activo !== undefined) empresa.activo = activo;

    await empresa.save();

    res.json({
      success: true,
      message: 'Empresa actualizada exitosamente',
      data: empresa
    });
  } catch (error) {
    console.error('❌ Error actualizando empresa:', error);
    res.status(500).json({
      success: false,
      error: 'Error al actualizar empresa',
      message: error.message
    });
  }
};

/**
 * Subir/actualizar certificado digital
 * POST /api/empresas/:id/certificado
 */
exports.subirCertificado = async (req, res) => {
  try {
    const { id } = req.params;
    const { contrasena } = req.body;
    
    // Validar contraseña
    if (!contrasena) {
      return res.status(400).json({
        success: false,
        error: 'La contraseña del certificado es requerida'
      });
    }
    
    // Validar archivo
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No se recibió el archivo del certificado'
      });
    }
    
    const empresa = await Empresa.findOne({
      _id: id,
      usuarioId: req.usuario._id
    });
    
    if (!empresa) {
      return res.status(404).json({
        success: false,
        error: 'Empresa no encontrada'
      });
    }
    
    // Guardar archivo .p12
    certificadoService.guardarCertificado(empresa.ruc, req.file.buffer);
    
    // Actualizar metadatos del certificado
    empresa.certificado = {
      nombreArchivo: req.file.originalname,
      contrasena: certificadoService.cifrarContrasena(contrasena),
      fechaCarga: new Date(),
      activo: true
    };
    
    // Nota: fechaVencimiento debería extraerse del certificado
    // Por ahora se deja null, se puede implementar con openssl
    
    await empresa.save();
    
    console.log(`✅ Certificado cargado para empresa: ${empresa.nombreFantasia}`);
    
    res.json({
      success: true,
      message: 'Certificado cargado exitosamente',
      data: {
        nombreArchivo: req.file.originalname,
        fechaCarga: empresa.certificado.fechaCarga
      }
    });
  } catch (error) {
    console.error('❌ Error subiendo certificado:', error);
    res.status(500).json({
      success: false,
      error: 'Error al subir certificado',
      message: error.message
    });
  }
};

/**
 * Validar certificado de una empresa
 * GET /api/empresas/:id/validar-certificado
 */
exports.validarCertificado = async (req, res) => {
  try {
    const { id } = req.params;
    
    const empresa = await Empresa.findOne({
      _id: id,
      usuarioId: req.usuario._id
    });
    
    if (!empresa) {
      return res.status(404).json({
        success: false,
        error: 'Empresa no encontrada'
      });
    }
    
    // Verificar certificado
    const tieneCertificado = empresa.tieneCertificadoValido();
    const infoCertificado = certificadoService.obtenerInfoCertificado(empresa.ruc);
    
    res.json({
      success: true,
      data: {
        tieneCertificado,
        certificadoActivo: empresa.certificado?.activo || false,
        certificadoEnFileSystem: infoCertificado?.existe || false,
        fechaVencimiento: empresa.certificado?.fechaVencimiento,
        fechaCarga: empresa.certificado?.fechaCarga,
        nombreArchivo: empresa.certificado?.nombreArchivo,
        infoAdicional: infoCertificado
      }
    });
  } catch (error) {
    console.error('❌ Error validando certificado:', error);
    res.status(500).json({
      success: false,
      error: 'Error al validar certificado',
      message: error.message
    });
  }
};

/**
 * Eliminar empresa
 * DELETE /api/empresas/:id
 */
exports.eliminar = async (req, res) => {
  try {
    const { id } = req.params;
    
    const empresa = await Empresa.findOne({
      _id: id,
      usuarioId: req.usuario._id
    });
    
    if (!empresa) {
      return res.status(404).json({
        success: false,
        error: 'Empresa no encontrada'
      });
    }
    
    // Verificar si tiene facturas asociadas
    const facturasCount = await Invoice.countDocuments({ empresaId: empresa._id });
    if (facturasCount > 0) {
      return res.status(400).json({
        success: false,
        error: `No se puede eliminar: la empresa tiene ${facturasCount} factura(s) asociada(s)`,
        mensaje: 'Elimine o reasigne las facturas antes de eliminar la empresa'
      });
    }
    
    // Eliminar certificado del filesystem
    certificadoService.eliminarCertificado(empresa.ruc);
    
    // Eliminar empresa
    await Empresa.deleteOne({ _id: id });
    
    console.log(`🗑️ Empresa eliminada: ${empresa.nombreFantasia} (RUC: ${empresa.ruc})`);
    
    res.json({
      success: true,
      message: 'Empresa eliminada correctamente'
    });
  } catch (error) {
    console.error('❌ Error eliminando empresa:', error);
    res.status(500).json({
      success: false,
      error: 'Error al eliminar empresa',
      message: error.message
    });
  }
};

/**
 * Obtener estadísticas de una empresa
 * GET /api/empresas/:id/stats
 */
exports.obtenerStats = async (req, res) => {
  try {
    const { id } = req.params;
    
    const empresa = await Empresa.findOne({
      _id: id,
      usuarioId: req.usuario._id
    });
    
    if (!empresa) {
      return res.status(404).json({
        success: false,
        error: 'Empresa no encontrada'
      });
    }
    
    // Obtener estadísticas de facturas
    const totalFacturas = await Invoice.countDocuments({ empresaId: empresa._id });
    
    const facturasPorEstado = await Invoice.aggregate([
      { $match: { empresaId: empresa._id } },
      { $group: { _id: '$estadoSifen', count: { $sum: 1 } } }
    ]);
    
    const ultimaFactura = await Invoice.findOne({ empresaId: empresa._id })
      .sort({ fechaCreacion: -1 })
      .select('fechaCreacion correlativo');
    
    res.json({
      success: true,
      data: {
        empresa: {
          nombreFantasia: empresa.nombreFantasia,
          ruc: empresa.ruc
        },
        totalFacturas,
        facturasPorEstado,
        ultimaFactura
      }
    });
  } catch (error) {
    console.error('❌ Error obteniendo estadísticas:', error);
    res.status(500).json({
      success: false,
      error: 'Error al obtener estadísticas',
      message: error.message
    });
  }
};
