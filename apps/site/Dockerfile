# harkroom.com 소개 페이지 이미지. 빌드 컨텍스트는 이 폴더(apps/site)다.
#   docker build -t harkroom-site apps/site && docker run --rm -p 8080:8080 harkroom-site
FROM node:22-alpine AS build
WORKDIR /site
COPY build.mjs ./
COPY src ./src
RUN node build.mjs

# 비루트(uid 101)·8080 으로 도는 nginx. 쿠버네티스에서 runAsNonRoot 를 걸어도 된다.
FROM nginxinc/nginx-unprivileged:1.29-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /site/dist /usr/share/nginx/html
EXPOSE 8080
