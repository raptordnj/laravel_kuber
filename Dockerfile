FROM composer:2 AS vendor
WORKDIR /app
COPY composer.json composer.lock* ./
RUN if [ -f composer.json ]; then composer install --no-dev --no-interaction --prefer-dist --optimize-autoloader --no-scripts; fi

FROM php:8.4-apache

ENV APACHE_DOCUMENT_ROOT=/var/www/html/public

RUN a2enmod rewrite headers status \
    && sed -ri "s!/var/www/html!${APACHE_DOCUMENT_ROOT}!g" /etc/apache2/sites-available/*.conf /etc/apache2/apache2.conf

# Cap Apache workers to bound memory, but keep enough headroom that health
# probes (/up) always get a worker even when /heavy saturates the pod —
# otherwise probes fail, pods go NotReady, and HPA loses metrics and can't scale.
RUN { \
    echo '<IfModule mpm_prefork_module>'; \
    echo '    StartServers         4'; \
    echo '    MinSpareServers      4'; \
    echo '    MaxSpareServers      8'; \
    echo '    MaxRequestWorkers   24'; \
    echo '    ServerLimit         24'; \
    echo '    MaxConnectionsPerChild 1000'; \
    echo '</IfModule>'; \
} > /etc/apache2/conf-available/mpm-tuning.conf \
    && a2enconf mpm-tuning

# PHP limits: 64M per request, 30s max execution
RUN { \
    echo 'memory_limit = 64M'; \
    echo 'max_execution_time = 30'; \
    echo 'max_input_time = 30'; \
} > /usr/local/etc/php/conf.d/limits.ini

RUN apt-get update && apt-get install -y --no-install-recommends \
        libicu-dev \
        libzip-dev \
        libpng-dev \
        libonig-dev \
        libxml2-dev \
        unzip \
        git \
        curl \
    && docker-php-ext-install pdo_mysql intl zip pcntl bcmath opcache \
    && rm -rf /var/lib/apt/lists/*

RUN pecl install redis \
    && docker-php-ext-enable redis

COPY --from=vendor /app/vendor /var/www/html/vendor
COPY . /var/www/html

RUN chown -R www-data:www-data /var/www/html \
    && mkdir -p /var/www/html/storage /var/www/html/bootstrap/cache \
    && chown -R www-data:www-data /var/www/html/storage /var/www/html/bootstrap/cache

USER www-data

EXPOSE 80
CMD ["apache2-foreground"]
