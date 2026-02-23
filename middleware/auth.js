const jwt = require('jsonwebtoken');
const User = require('../models/User');
const ApiKey = require('../models/ApiKey');

// Middleware para verificar el token JWT O API Key
const verificarToken = async (req, res, next) => {
  try {
    // Obtener token del header
    const authHeader = req.headers['authorization'];
    const token = authHeader?.replace('Bearer ', '');
    
    // Si no hay token, intentar con API Key
    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'No se proporcionó token de autenticación o API Key'
      });
    }

    // Intentar verificar como JWT primero
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'sifen-secret-key-change-in-production');
      
      // Buscar usuario en la base de datos
      const usuario = await User.findById(decoded.userId).select('-password');
      
      if (!usuario || !usuario.activo) {
        return res.status(401).json({
          success: false,
          error: 'Usuario no encontrado o inactivo'
        });
      }

      // Agregar usuario al request
      req.usuario = usuario;
      req.tipoAutenticacion = 'jwt';
      
      next();
      return;
    } catch (jwtError) {
      // No es un JWT válido, intentar como API Key
    }

    // Intentar como API Key
    const apiKey = await ApiKey.encontrarPorKey(token);
    
    if (!apiKey) {
      return res.status(401).json({
        success: false,
        error: 'Token o API Key inválidos'
      });
    }

    // Verificar si la API Key expiró
    if (apiKey.expiracion && apiKey.expiracion < new Date()) {
      apiKey.activa = false;
      await apiKey.save();
      return res.status(401).json({
        success: false,
        error: 'API Key expirada'
      });
    }

    // Buscar el usuario propietario de la API Key
    const usuario = await User.findById(apiKey.usuario).select('-password');
    
    if (!usuario || !usuario.activo) {
      return res.status(401).json({
        success: false,
        error: 'Usuario de la API Key no encontrado o inactivo'
      });
    }

    // Actualizar último uso
    apiKey.ultimoUso = new Date();
    apiKey.ipOrigen = req.ip;
    await apiKey.save();

    // Agregar usuario y API Key al request
    req.usuario = usuario;
    req.apiKey = apiKey;
    req.tipoAutenticacion = 'apikey';
    
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        error: 'Token inválido'
      });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'Token expirado'
      });
    }
    
    console.error('Error verificando autenticación:', error);
    res.status(500).json({
      success: false,
      error: 'Error al verificar autenticación'
    });
  }
};

// Middleware para verificar rol de administrador
const verificarAdmin = (req, res, next) => {
  if (req.usuario.rol !== 'admin') {
    return res.status(403).json({
      success: false,
      error: 'Acceso denegado. Se requiere rol de administrador'
    });
  }
  next();
};

// Middleware para verificar permisos de API Key
const verificarPermiso = (permisoRequerido) => {
  return (req, res, next) => {
    // Si es JWT, verificar rol
    if (req.tipoAutenticacion === 'jwt') {
      return next();
    }
    
    // Si es API Key, verificar permisos
    if (req.apiKey && req.apiKey.permisos) {
      if (req.apiKey.permisos.includes(permisoRequerido) || 
          req.apiKey.permisos.includes('admin')) {
        return next();
      }
      
      return res.status(403).json({
        success: false,
        error: 'API Key no tiene permisos suficientes',
        permisosRequeridos: [permisoRequerido],
        permisosActuales: req.apiKey.permisos
      });
    }
    
    next();
  };
};

module.exports = {
  verificarToken,
  verificarAdmin,
  verificarPermiso
};
