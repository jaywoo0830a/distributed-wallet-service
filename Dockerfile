# Use Node.js 24 on Alpine Linux for a small footprint
FROM node:24-alpine

WORKDIR /app

# Copy package files
# In dev mode (docker-compose), this is overridden by volume mounts,
# but essential for standalone builds or production.
COPY package*.json ./

# Install dependencies (placeholder for production builds)
# In dev mode, dependencies are installed on the host via init.sh and mounted.
RUN npm install --omit=dev

# Copy application source code
COPY . .

# Expose the API port
EXPOSE 3000

# Default command uses nodemon in dev mode (overridden by docker-compose)
CMD ["npm", "run", "dev"]