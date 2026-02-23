const mongoose = require('mongoose');
const crypto = require('crypto');

const apiKeySchema = new mongoose.Schema({
  key: {
    type: String,
    unique: true,
    index: true,
    default: function() {
      return crypto.randomBytes(32).toString('hex');
    }
  },
  keyHash: {
    type: String,
    default: function() {
      // Este valor se actualizará en el hook pre-save
      return '';
    }
  },
  nombre: {
    type: String,
    required: true,
    trim: true
  },
  descripcion: {
    type: String,
    trim: true
  },
  usuario: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  // NUEVO: Empresa asociada (opcional)
  // Si es null, la key funciona para todas las empresas del usuario
  empresaId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Empresa',
    default: null,
    index: true
  },
  permisos: {
    type: [String],
    enum: ['facturas:crear', 'facturas:leer', 'facturas:eliminar', 'stats:leer', 'admin'],
    default: ['facturas:crear', 'facturas:leer', 'stats:leer']
  },
  activa: {
    type: Boolean,
    default: true
  },
  expiracion: {
    type: Date
  },
  ultimoUso: {
    type: Date
  },
  ipOrigen: {
    type: String
  },
  fechaCreacion: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Método para verificar si la API key es válida
apiKeySchema.methods.verificarKey = function(key) {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  return this.keyHash === hash;
};

// Método estático para encontrar una API key por el valor plano
apiKeySchema.statics.encontrarPorKey = async function(key) {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  return await this.findOne({ keyHash: hash, activa: true });
};

// Hook pre-save para generar el hash
apiKeySchema.pre('save', function(next) {
  // Generar key si no existe (por si el default no se ejecutó)
  if (!this.key || this.key === '') {
    this.key = crypto.randomBytes(32).toString('hex');
  }

  // Generar hash de la key
  this.keyHash = crypto.createHash('sha256').update(this.key).digest('hex');

  next();
});

module.exports = mongoose.model('ApiKey', apiKeySchema);
