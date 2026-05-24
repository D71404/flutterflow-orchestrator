# Use Node.js 20 on Debian Bullseye as base image
FROM node:20-bullseye

# Install dependencies for Dart SDK
RUN apt-get update && apt-get install -y \
    apt-transport-https \
    wget \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Add Dart SDK repository and signing key
RUN wget -qO- https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - && \
    echo 'deb https://storage.googleapis.com/download.dartlang.org/linux/debian stable main' | tee /etc/apt/sources.list.d/dart_stable.list

# Install Dart SDK
RUN apt-get update && \
    apt-get install -y dart && \
    rm -rf /var/lib/apt/lists/*

# Configure PATH to include Dart and pub cache binaries
ENV PATH="/usr/lib/dart/bin:/root/.pub-cache/bin:${PATH}"

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Activate FlutterFlow CLI globally
RUN dart pub global activate flutterflow_cli

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json ./
COPY package-lock.json* ./

# Install Node.js dependencies
RUN npm install

# Copy all source files
COPY . .

# Expose port 8080 for Railway
EXPOSE 8080

# Set PORT environment variable for Railway (Railway expects port 8080)
ENV PORT=8080

# Start the application
CMD ["npm", "start"]