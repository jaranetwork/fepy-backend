/**
 * Middleware para manejo de archivos subidos (multer)
 * Específicamente para certificados digitales .p12
 */

const multer = require('multer');
const path = require('path');

// Configurar almacenamiento en memoria (para luego guardar con certificadoService)
const storage = multer.memoryStorage();

// Filtro de archivos - solo permitir .p12
const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  
  if (ext === '.p12') {
    cb(null, true);
  } else {
    cb(new Error('Solo se permiten archivos .p12 (certificados digitales)'), false);
  }
};

// Configurar multer
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5 MB máximo
  }
});

// Middleware para manejar errores de multer
const manejarErrorUpload = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: 'El archivo es demasiado grande. Máximo 5 MB'
      });
    }
    return res.status(400).json({
      success: false,
      error: `Error de subida: ${err.message}`
    });
  }
  
  if (err) {
    return res.status(400).json({
      success: false,
      error: err.message
    });
  }
  
  next();
};

module.exports = {
  upload,
  manejarErrorUpload
};
