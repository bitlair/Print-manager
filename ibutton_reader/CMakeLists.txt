cmake_minimum_required(VERSION 3.10)
project(ibutton_reader C)

set(CMAKE_C_STANDARD 99)
set(CMAKE_C_FLAGS "-O2")

# Add executable from src folder
add_executable(ibutton_reader src/ibutton_reader.c)