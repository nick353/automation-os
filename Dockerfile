FROM public.ecr.aws/docker/library/node:22-bookworm-slim

WORKDIR /app

# Install devDependencies because the production build compiles TypeScript and
# bundles the web application before the server is started.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080

EXPOSE 8080
CMD ["npm", "run", "start:server"]
