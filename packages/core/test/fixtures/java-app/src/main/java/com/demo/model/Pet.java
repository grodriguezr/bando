package com.demo.model;

public record Pet(String name) {
    public String label() {
        return name.toUpperCase();
    }
}
