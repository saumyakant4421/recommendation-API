const express = require('express');
const cors = require('cors');
const routes = require('./routes/recommendationRoutes');
const logger = require('./utils/logger');

const app = express();
const PORT = process.env.PORT || 4002;

// CORS configuration
if (process.env.NODE_ENV === 'production') {
  app.use(cors({
    origin: 'https://streamverse-frontend-v0.onrender.com',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control'],
    credentials: true
  }));
} else {
  app.use(cors({
    origin: 'http://localhost:3000',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control'],
    credentials: true
  }));
}

// Middleware
app.use(express.json());

// Routes
app.use('/api/recommendations', routes);

// Error handling
app.use((err, req, res, next) => {
  logger.error(`Server error: ${err.message}`);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  if (process.env.NODE_ENV === 'production') {
    logger.info(`Recommendation service running in PRODUCTION on port ${PORT}`);
  } else {
    logger.info(`Recommendation service running in DEVELOPMENT on port ${PORT}`);
  }
});