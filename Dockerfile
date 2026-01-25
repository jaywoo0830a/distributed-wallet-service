# Use Node.js 24 Alpine
FROM node:24-alpine

WORKDIR /app

# In development via docker-compose, the volume mount overrides this.
# But for a standalone image build, we allow copying.
COPY package*.json ./

# Just a placeholder, as dependencies are managed via volume in dev
RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "run", "dev"]