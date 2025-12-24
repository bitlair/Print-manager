#include <stdio.h>
#include <stdint.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/mman.h>
#include <time.h>
#include <stdlib.h>
#include <string.h>

#define BCM2708_PERI_BASE 0x3F000000
#define GPIO_BASE_OFFSET 0x200000
#define GPIO_BASE (BCM2708_PERI_BASE + GPIO_BASE_OFFSET)

#define ONEWIRE_GPIO 4  // BCM pin

volatile unsigned *gpio;

// Timing constants (microseconds)
#define DELAY_RESET_PULSE 550
#define DELAY_PRESENCE_WAIT 100
#define DELAY_SLOT 80
#define DELAY_RECOVERY 1

#define READ_RETRIES 3 // Number of times to read each ROM for validation


// socket stuff
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <signal.h>

#define SOCKET_SERVER_PORT 5000


// ===== GPIO functions =====
static void delay_us(int us)
{
    struct timespec start, now;
    clock_gettime(CLOCK_MONOTONIC, &start);
    long elapsed;
    do {
        clock_gettime(CLOCK_MONOTONIC, &now);
        elapsed = (now.tv_sec - start.tv_sec) * 1000000
                + (now.tv_nsec - start.tv_nsec) / 1000;
    } while (elapsed < us);
}

static void gpio_set_output(int pin)
{
    int reg = pin / 10;
    int shift = (pin % 10) * 3;
    gpio[reg] = (gpio[reg] & ~(7 << shift)) | (1 << shift);
}

static void gpio_set_input(int pin)
{
    int reg = pin / 10;
    int shift = (pin % 10) * 3;
    gpio[reg] &= ~(7 << shift);
}

static void gpio_write(int pin, int value)
{
    if (value)
        gpio[7] = 1 << pin;
    else
        gpio[10] = 1 << pin;
}

static int gpio_read(int pin)
{
    return (gpio[13] >> pin) & 1;
}

// ===== 1-Wire functions =====
static int onewire_reset()
{
    gpio_set_output(ONEWIRE_GPIO);
    gpio_write(ONEWIRE_GPIO, 0);
    delay_us(DELAY_RESET_PULSE);

    gpio_set_input(ONEWIRE_GPIO);
    delay_us(DELAY_PRESENCE_WAIT);
    int present = !gpio_read(ONEWIRE_GPIO);
    delay_us(DELAY_RESET_PULSE - DELAY_PRESENCE_WAIT);
    return present;
}

static void onewire_write_bit(int bit)
{
    gpio_set_output(ONEWIRE_GPIO);
    gpio_write(ONEWIRE_GPIO, 0);

    if (bit)
        delay_us(5);
    else
        delay_us(DELAY_SLOT);

    gpio_set_input(ONEWIRE_GPIO);
    if (bit)
        delay_us(DELAY_SLOT - 5);
    else
        delay_us(DELAY_RECOVERY);
}

static int onewire_read_bit()
{
    int bit;

    gpio_set_output(ONEWIRE_GPIO);
    gpio_write(ONEWIRE_GPIO, 0);
    delay_us(2);

    gpio_set_input(ONEWIRE_GPIO);
    delay_us(8);

    bit = gpio_read(ONEWIRE_GPIO);
    delay_us(DELAY_SLOT - 10);
    return bit;
}

static void onewire_write_byte(uint8_t byte)
{
    for (int i = 0; i < 8; i++)
        onewire_write_bit((byte >> i) & 1);
}

static uint8_t onewire_read_byte()
{
    uint8_t byte = 0;
    for (int i = 0; i < 8; i++)
        if (onewire_read_bit())
            byte |= 1 << i;
    return byte;
}

// ===== CRC-8 calculation =====
static uint8_t crc8(const uint8_t *data, int len)
{
    uint8_t crc = 0;
    for (int i = 0; i < len; i++)
    {
        uint8_t inbyte = data[i];
        for (int j = 0; j < 8; j++)
        {
            uint8_t mix = (crc ^ inbyte) & 0x01;
            crc >>= 1;
            if (mix) crc ^= 0x8C; // polynomial X^8 + X^5 + X^4 + 1
            inbyte >>= 1;
        }
    }
    return crc;
}

// ===== Compare two ROMs =====
static int rom_equal(uint8_t *a, uint8_t *b)
{
    for (int i = 0; i < 8; i++)
        if (a[i] != b[i])
            return 0;
    return 1;
}

// Function to connect socket
int connect_socket(struct sockaddr_in *addr)
{
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) { perror("socket"); return -1; }

    if (connect(fd, (struct sockaddr*)addr, sizeof(*addr)) < 0)
    {
        perror("connect");
        close(fd);
        return -1;
    }

    return fd;
}

// ===== Main =====
int main()
{
    int sock_fd = -1; // <-- add this
	
	// Ignore SIGPIPE so that writing to a closed socket doesn't crash the program
    signal(SIGPIPE, SIG_IGN);
	
	// Outside the loop — only needs to be done once
	struct sockaddr_in addr;
	memset(&addr, 0, sizeof(addr));
	addr.sin_family = AF_INET;
	addr.sin_port = htons(SOCKET_SERVER_PORT);
	addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

    int mem_fd = open("/dev/gpiomem", O_RDWR | O_SYNC);
    if (mem_fd < 0)
    {
        perror("open /dev/gpiomem");
        return 1;
    }

    gpio = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, mem_fd, GPIO_BASE);
    if (gpio == MAP_FAILED)
    {
        perror("mmap");
        return 1;
    }

    printf("Waiting for iButton on GPIO %d...\n", ONEWIRE_GPIO);
	
	uint8_t last_rom[8] = {0};
	int last_rom_valid = 0;           // track if last_rom is currently valid
	time_t last_release_time = 0;     // time when button was released

    while (1)
	{
		// Wait for iButton presence
		while (!onewire_reset())
		{
			// Check if 5 seconds have passed since last release
			if (last_rom_valid && last_release_time != 0)
			{
				time_t now = time(NULL);
				if (now - last_release_time >= 1)
				{
					memset(last_rom, 0, 8);
					last_rom_valid = 0;
					last_release_time = 0;
					printf("[DEBUG] Last ROM forgotten after 1 seconds\n");
				}
			}
			usleep(20000);
		}

		// Button detected, read ROM
		onewire_write_byte(0x33); // READ ROM
		uint8_t rom[8];
		for (int i = 0; i < 8; i++)
			rom[i] = onewire_read_byte();

		// Check CRC
		uint8_t crc = crc8(rom, 7);
		if (crc != rom[7])
			continue;
		
		// Check trailing FF or 00
		int trailing_ff = 0;
		int trailing_00 = 0;
		for (int i = 7; i >= 0; i--)
		{
			if (rom[i] == 0xFF)
				trailing_ff++;
			else
				break;
		}
		
		for (int i = 7; i >= 0; i--)
		{
			if (rom[i] == 0x00)
				trailing_00++;
			else
				break;
		}

		if (trailing_ff >= 6)
		{
			//printf("[DEBUG] Discarded due to trailing FF: %d bytes\n", trailing_ff);
			continue;
		}

		if (trailing_00 >= 6)
		{
			//printf("[DEBUG] Discarded due to trailing 00: %d bytes\n", trailing_00);
			continue;
		}
		// Print only if new ROM
		if (!rom_equal(rom, last_rom))
		{
			printf("iButton ROM: ");
			for (int i = 0; i < 8; i++)
				printf("%02X", rom[i]);
			printf("  (last ROM: ");
			for (int i = 0; i < 8; i++)
				printf("%02X", last_rom[i]);
			printf(")\n");
			
			
			char msg[17];
			snprintf(msg, sizeof(msg), "%02X%02X%02X%02X%02X%02X%02X%02X",
					 rom[0], rom[1], rom[2], rom[3], rom[4], rom[5], rom[6], rom[7]);

			// Reconnect if needed
			if (sock_fd < 0)
				sock_fd = connect_socket(&addr);

			if (sock_fd >= 0)
			{
				ssize_t n = send(sock_fd, msg, strlen(msg), 0);
				if (n < 0)
				{
					perror("send failed");
					close(sock_fd);
					sock_fd = -1;
				}
			}
			
			memcpy(last_rom, rom, 8);
			last_rom_valid = 1;
		}

		// Wait for button removal before next detection
		while (!onewire_read_bit())
			usleep(50000);

		// Start 5-second timer for forgetting last ROM
		if (last_rom_valid)
			last_release_time = time(NULL);
	}



    return 0;
}
