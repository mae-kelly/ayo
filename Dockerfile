# Multi-stage build for optimized Rust binary
FROM rust:1.75 as builder

# Install dependencies
RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    clang \
    cmake \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy manifests
COPY Cargo.toml Cargo.lock ./

# Build dependencies (cached layer)
RUN mkdir src && \
    echo "fn main() {}" > src/main.rs && \
    cargo build --release && \
    rm -rf src

# Copy source code
COPY src ./src
COPY abi ./abi

# Build application
RUN touch src/main.rs && \
    cargo build --release

# Runtime stage
FROM debian:bookworm-slim

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd -m -u 1000 liquidator && \
    mkdir -p /app/logs /app/data && \
    chown -R liquidator:liquidator /app

WORKDIR /app

# Copy binary from builder
COPY --from=builder /app/target/release/liquidation-bot /app/
COPY --chown=liquidator:liquidator abi ./abi

# Switch to non-root user
USER liquidator

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD ["/app/liquidation-bot", "--health-check"]

# Run the bot
ENTRYPOINT ["/app/liquidation-bot"]