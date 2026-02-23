const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');

const empresaSchema = new mongoose.Schema({
  // Identidad tributaria (LO MÁS IMPORTANTE)
  ruc: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    validate: {
      validator: function(v) {
        // Acepta RUC con o sin guiones, mínimo 6 dígitos
        // Ejemplos válidos: 8001234-5, 80012345, 80012345-1, 2005001-1
        const sinGuiones = v.replace(/[^0-9]/g, '');
        return sinGuiones.length >= 6 && sinGuiones.length <= 12;
      },
      message: 'RUC inválido. Debe tener entre 6-12 dígitos'
    },
    index: true
  },
  nombreFantasia: {
    type: String,
    required: true,
    trim: true
  },
  razonSocial: {
    type: String,
    required: true,
    trim: true
  },
  
  // Configuración SIFEN v150 (datos específicos de cada empresa)
  // NOTA: Establecimiento y Punto de Emisión se generan automáticamente según SIFEN v150
  configuracionSifen: {
    // Timbrado proporcionado por SET
    timbrado: {
      type: String,
      required: true,
      default: '12345678',
      maxlength: 8
    },
    // CSC - Código Secreto del Contribuyente (proporcionado por SET)
    idCSC: {
      type: String,
      required: true,
      default: '0001',
      maxlength: 4
    },
    csc: {
      type: String,
      required: true,
      maxlength: 32,
      minlength: 32
    },
    // Modo de operación
    modo: {
      type: String,
      enum: ['test', 'produccion'],
      default: 'test'
    }
  },
  
  // Certificado digital (solo metadatos, archivo en filesystem)
  certificado: {
    nombreArchivo: String,
    contrasena: String,  // Cifrada con AES-256
    fechaVencimiento: Date,
    fechaCarga: Date,
    activo: {
      type: Boolean,
      default: false
    }
  },
  
  // Relación con el usuario admin (dueño)
  usuarioId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  // Datos de contacto
  direccion: String,
  telefono: String,
  email: {
    type: String,
    lowercase: true,
    trim: true
  },
  
  // Estado
  activo: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Método: Obtener ruta del certificado
empresaSchema.methods.obtenerRutaCertificado = function() {
  const basePath = process.env.CERTIFICADOS_PATH || 
    path.join(__dirname, '../certificados');
  return path.join(basePath, this.ruc, 'certificado.p12');
};

// Método: Verificar si tiene certificado válido
empresaSchema.methods.tieneCertificadoValido = function() {
  if (!this.certificado?.activo) return false;
  const ruta = this.obtenerRutaCertificado();
  const existe = require('fs').existsSync(ruta);
  // La fecha de vencimiento es opcional, solo verificamos que el archivo exista
  return existe;
};

// Método estático: Buscar por RUC
empresaSchema.statics.findByRuc = function(ruc) {
  return this.findOne({ ruc });
};

// Middleware: Normalizar RUC con guión antes de guardar
// El RUC paraguayo tiene formato: 8 dígitos + guión + 1 dígito verificador
// Ejemplo: 8001234-5, 2005001-1
empresaSchema.pre('save', function(next) {
  if (this.isNew || this.isModified('ruc')) {
    // Si el RUC no tiene guión y tiene 7-9 dígitos, agregar guión antes del último
    const rucSinGuiones = this.ruc.replace(/[^0-9]/g, '');
    if (rucSinGuiones.length >= 7 && rucSinGuiones.length <= 9 && !this.ruc.includes('-')) {
      // Insertar guión antes del último dígito (DV)
      const parteNumerica = rucSinGuiones.slice(0, -1);
      const dv = rucSinGuiones.slice(-1);
      this.ruc = `${parteNumerica}-${dv}`;
    }
  }
  next();
});

// Middleware: Crear carpeta RUC al crear empresa
empresaSchema.pre('save', async function(next) {
  if (this.isNew) {
    const certificadoService = require('../services/certificadoService');
    certificadoService.crearCarpetaRuc(this.ruc);
  }
  next();
});

module.exports = mongoose.model('Empresa', empresaSchema);
