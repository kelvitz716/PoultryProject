FROM nginx:alpine

# Copy the static web files into the standard Nginx hosting directory
COPY . /usr/share/nginx/html

# Expose port 80 internally
EXPOSE 80

# Start Nginx in the foreground
CMD ["nginx", "-g", "daemon off;"]
