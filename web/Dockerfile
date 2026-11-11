# Multi-stage build: compile the Vite SPA, then serve the static output with nginx.
#
# VITE_ALBUS_API_URL must be passed as --build-arg (Vite inlines VITE_* env
# vars at build time, not at container runtime) — point it at the public
# api.albus.* URL for production builds.

FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ARG VITE_ALBUS_API_URL
ENV VITE_ALBUS_API_URL=$VITE_ALBUS_API_URL

RUN npm run build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/health || exit 1

CMD ["nginx", "-g", "daemon off;"]
