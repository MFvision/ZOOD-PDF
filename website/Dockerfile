# A small image that serves the website with Caddy.
#   docker build -t zood-pdf-site website/
#   docker run -p 80:80 -p 443:443 -v caddy_data:/data zood-pdf-site
FROM caddy:2.10-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY . /srv
